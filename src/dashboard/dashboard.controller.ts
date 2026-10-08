import { applyNodePricingUpdates } from "../config/node-pricing-update";
// ===================================================================
// DashboardController — Dashboard REST API + SSE
// ===================================================================
// Endpoints:
//   GET  /api/dashboard/stats     — Aggregated statistics
//   GET  /api/dashboard/logs      — Recent call logs (paginated)
//   GET  /api/dashboard/logs/sse  — Real-time SSE log stream
//   GET  /api/dashboard/budget    — Budget status + management
//   POST /api/dashboard/budget/:id/reset — Reset a budget rule
//   GET  /api/dashboard/config    — Gateway configuration (sanitized)
//   POST /api/dashboard/config/reload — Hot-reload config
//   GET  /api/dashboard/nodes     — Node health + circuit status
//   POST /api/dashboard/nodes/test — Test node connectivity
//   POST /api/dashboard/nodes     — Create a new node
//   PUT  /api/dashboard/nodes/:id — Update an existing node
//   DELETE /api/dashboard/nodes/:id — Delete a node
//   POST /api/dashboard/nodes/:id/reset — Reset node circuit breaker
// ===================================================================

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  BeforeApplicationShutdown,
  Sse,
  Logger,
  Res,
  Req,
  MessageEvent,
  ParseIntPipe,
  DefaultValuePipe,
  HttpException,
  HttpStatus,
  UseGuards,
  Optional,
  Inject,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { Request, Response } from "express";
import { InjectRepository } from "@nestjs/typeorm";
import {
  DataSource,
  FindOptionsWhere,
  In,
  MoreThanOrEqual,
  Repository,
  type EntityManager,
} from "typeorm";
import { Observable, filter, interval, map, merge } from "rxjs";
import { withCoordinatedRepository } from "../database/coordinated-repository";
import { ConfigService } from "../config/config.service";
import { CapabilityService } from "../config/capability.service";
import { SecretReferenceResolverService } from "../config/secret-reference-resolver.service";
import { maskSecretForDisplay } from "../config/secret-references";
import { RoutingService } from "../routing/routing.service";
import {
  CircuitBreakerService,
  CircuitState,
} from "../routing/circuit-breaker.service";
import { ConcurrencyLimiterService } from "../routing/concurrency-limiter.service";
import { ActiveHealthProbeService } from "../routing/active-health-probe.service";
import { CredentialPoolService } from "../providers/credential-pool.service";
import { BudgetService } from "../budget/budget.service";
import {
  CallLog,
  RouteDecisionLog,
  ShadowTrafficResult,
} from "../database/entities";
import type { RouteDecisionTrace } from "../routing/route-decision-trace";
import { LogEventBus } from "./log-event-bus";
import { CreateNodeDto, UpdateNodeDto, TestNodeDto } from "./dto/node.dto";
import { DashboardGuard } from "../auth/dashboard.guard";
import { DashboardRbacGuard } from "../auth/dashboard-rbac.guard";
import { RequireDashboardRole } from "../auth/dashboard-rbac";
import { WorkspaceMembershipService } from "../auth/workspace-membership.service";
import { WorkspaceInvitationService } from "../auth/workspace-invitation.service";
import { ManagementAuditService } from "../audit/management-audit.service";
import type { ManagementAuditResult } from "../database/entities";
import type {
  WorkspaceMembershipRole,
  WorkspaceMembershipStatus,
} from "../database/entities";
import { PromptCacheService } from "../cache/prompt-cache.service";
import { TelemetryService } from "../telemetry/telemetry.service";
import { RoutingRecommendationService } from "../routing/routing-recommendation.service";
import { ShadowTrafficService } from "../shadow/shadow-traffic.service";
import { RealtimeProxyService } from "../realtime/realtime-proxy.service";
import { McpGatewayService } from "../mcp/mcp-gateway.service";
import { PluginRegistryService } from "../plugins/plugin-registry.service";
import {
  assessCatalogPricing,
  CatalogService,
  summarizeCatalogProviderVisibility,
} from "../catalog/catalog.service";
import { getCatalogRefreshSources } from "../catalog/catalog-refresh";
import { buildCatalogSyncStatus } from "../catalog/catalog-sync";
import {
  listCompatibilityProfiles,
  resolveNodeCompatibilityProfileIds,
} from "../catalog/compatibility-profiles";
import {
  shouldExposeProviderByDefault,
  shouldExposeProviderWithLegacyToggle,
  buildCanonicalProjectionBindings,
} from "../catalog/provider-projection";
import { BUILTIN_PROVIDER_CATALOG } from "../catalog/built-in-catalog";
import type {
  CatalogCanonicalModel,
  CatalogInternalMaterialization,
  CatalogModel,
  CatalogPricing,
  CatalogProvider,
} from "../catalog/catalog.types";
import type { Modality } from "../config/modality";
import type { ProviderCompatibilityCapability } from "../database/entities";
import { ProviderCompatibilityService } from "./provider-compatibility.service";
import { ConfigAuditService } from "./config-audit.service";
import { BenchmarkReportService } from "./benchmark-report.service";
import {
  CacheSavingsService,
  CacheSavingsGroupBy,
} from "./cache-savings.service";
import { ProviderExtensibilityService } from "./provider-extensibility.service";
import {
  CustomProviderTemplatePreviewDto,
  ProviderSdkGeneratorDto,
} from "./dto/provider-extensibility.dto";
import { BatchJobStoreService } from "../batch/batch-job-store.service";
import {
  fetchErrorMessage,
  fetchWithTimeout,
  redactedFetchErrorMessage,
} from "../http/fetch-with-timeout";
import { WorkspaceContextService } from "../workspaces/workspace-context.service";
import { WorkspaceService } from "../workspaces/workspace.service";
import {
  applyWorkspaceQueryScope,
  normalizeWorkspaceId,
  workspaceFindWhereStrict,
} from "../workspaces/workspace-scope";
import { SqliteAnalyticsService } from "../database/sqlite-analytics.service";
import {
  CreateGatewayApiKeyDto,
  UpdateGatewayApiKeyDto,
} from "../auth/dto/gateway-api-key.dto";
import { GatewayApiKeyService } from "../auth/gateway-api-key.service";
import { CreateTeamDto, UpdateTeamDto } from "../auth/dto/team.dto";
import { TeamService } from "../auth/team.service";
import {
  CreateNamespaceDto,
  DeleteNamespaceDto,
  UpdateNamespaceDto,
} from "./dto/namespace.dto";
import { AgentProfileService } from "../agent-profiles/agent-profile.service";
import { AgentPlatformService } from "../agent-platform/agent-platform.service";
import { ClusterService } from "../cluster/cluster.service";
import type { NamespaceConfig } from "../config/gateway.config";
import {
  CreateAgentProfileDto,
  RenderAgentProfileDto,
  UpdateAgentProfileDto,
} from "../agent-profiles/dto/agent-profile.dto";
import {
  ActionResponseDto,
  AgentProfileListResponseDto,
  AgentProfileMutationResponseDto,
  AgentProfileRenderResponseDto,
  AgentPlatformResponseDto,
  ErrorEnvelopeDto,
  GatewayApiKeyCreatedResponseDto,
  GatewayApiKeyListResponseDto,
  GatewayApiKeyMutationResponseDto,
  ManagementAuditEventsResponseDto,
  WorkspaceMemberListResponseDto,
  WorkspaceMemberMutationResponseDto,
  WorkspaceInvitationListResponseDto,
  WorkspaceInvitationMutationResponseDto,
  SanitizedConfigResponseDto,
  WorkspaceStateResponseDto,
  WorkspaceMutationResponseDto,
} from "../openapi/openapi.dto";

const DASHBOARD_PROTOCOLS = [
  "chat_completions",
  "responses",
  "messages",
  "gemini",
] as const;
const DASHBOARD_MODEL_BUCKETS = [
  "models",
  "embedding_models",
  "rerank_models",
  "image_models",
  "audio_models",
  "video_models",
  "realtime_models",
  "batch_models",
] as const;
const DASHBOARD_RECOMMENDED_MODEL_LIMITS: Record<
  (typeof DASHBOARD_MODEL_BUCKETS)[number],
  number
> = {
  models: 4,
  embedding_models: 2,
  rerank_models: 2,
  image_models: 3,
  audio_models: 3,
  video_models: 2,
  realtime_models: 2,
  batch_models: 2,
};
type DashboardProviderFamily =
  | "foundation"
  | "aggregators"
  | "cloud"
  | "china"
  | "self_hosted"
  | "image_video"
  | "speech_audio"
  | "embedding_rerank";
type DashboardProviderType =
  | "direct"
  | "aggregator"
  | "cloud"
  | "self_hosted"
  | "media"
  | "speech"
  | "local"
  | "custom"
  | "compatible";
type DashboardCompatibilityProfile =
  | "native"
  | "openai-compatible"
  | "anthropic-compatible"
  | "google-compatible"
  | "local"
  | "custom";
type DashboardModelBucket = (typeof DASHBOARD_MODEL_BUCKETS)[number];
type DashboardPricingTrustStatus =
  | "aligned_estimate"
  | "reference_estimate"
  | "review_required"
  | "missing";

type BudgetScopeKind = "global" | "namespace" | "team" | "api_key";

interface DashboardStatsResponse {
  period: number;
  total: {
    calls: number;
    success: number;
    failed: number;
    successRate: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    avgLatencyMs: number;
    uniqueSessions: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  last24h: {
    calls: number;
    costUsd: number;
    tokens: number;
  };
  tierDistribution: Array<{ tier: string; count: number }>;
  nodeDistribution: Array<{
    nodeId: string;
    count: number;
    avgLatencyMs: number;
  }>;
}

const BUDGET_SCOPE_ORDER: BudgetScopeKind[] = [
  "global",
  "namespace",
  "team",
  "api_key",
];

const BUDGET_SOURCE_OF_TRUTH: Record<BudgetScopeKind, string> = {
  global: "global_config",
  namespace: "policy_namespace_config",
  team: "team_policy",
  api_key: "api_key_policy",
};

const BUDGET_EDITABLE_VIA: Record<BudgetScopeKind, string> = {
  global: "config_file",
  namespace: "policy_namespace_api",
  team: "team_api",
  api_key: "api_key_api",
};

const BUDGET_SCOPE_LABEL: Record<BudgetScopeKind, string> = {
  global: "Global",
  namespace: "Policy Namespace",
  team: "Team",
  api_key: "Gateway API Key",
};

const DASHBOARD_PROVIDER_ALIAS_HINTS: Record<string, string[]> = {
  openai: ["gpt", "o-series", "dall-e", "openai api"],
  anthropic: ["claude"],
  "google-gemini": ["gemini", "google ai studio"],
  "google-vertex": ["vertex", "gemini vertex", "veo", "imagen"],
  "azure-openai": ["azure", "azure ai foundry"],
  "aws-bedrock": ["bedrock", "amazon bedrock", "amazon titan"],
  "alibaba-qwen": ["qwen", "tongyi", "dashscope", "通义", "千问"],
  "baidu-qianfan": ["baidu", "wenxin", "qianfan", "ernie", "文心", "千帆"],
  "volcengine-ark": ["doubao", "volcengine", "ark", "火山", "豆包"],
  zhipu: ["zhipu", "glm", "chatglm", "智谱"],
  moonshot: ["moonshot", "kimi", "月之暗面"],
  "tencent-hunyuan": ["hunyuan", "tencent", "混元", "腾讯"],
  "01ai": ["01.ai", "yi", "lingyiwanwu", "零一万物"],
  openrouter: ["router", "aggregator"],
  huggingface: ["hugging face", "hf", "inference endpoint"],
  "cloudflare-workers-ai": ["cloudflare", "workers ai"],
  "stability-ai": ["stability", "stable diffusion"],
  "black-forest-labs": ["bfl", "flux"],
  "fal-ai": ["fal"],
  "luma-ai": ["luma", "dream machine"],
  elevenlabs: ["eleven labs", "tts", "voice"],
  deepgram: ["speech to text", "stt"],
  "openai-compatible": ["compatible proxy", "custom provider", "self hosted"],
};

const DASHBOARD_AGGREGATOR_PROVIDER_IDS = new Set([
  "openrouter",
  "together",
  "fireworks",
  "replicate",
  "fal-ai",
  "perplexity",
]);
const DASHBOARD_CLOUD_PROVIDER_IDS = new Set([
  "aws-bedrock",
  "azure-openai",
  "google-vertex",
  "cloudflare-workers-ai",
  "ibm-watsonx",
  "nvidia-nim",
  "baseten",
  "lepton-ai",
  "modal",
  "runpod",
  "predibase",
  "cerebras",
  "sambanova",
]);
const DASHBOARD_CHINA_PROVIDER_IDS = new Set([
  "alibaba-qwen",
  "baidu-qianfan",
  "volcengine-ark",
  "zhipu",
  "moonshot",
  "minimax",
  "tencent-hunyuan",
  "01ai",
  "deepseek",
]);
const DASHBOARD_LOCAL_PROVIDER_IDS = new Set([
  "ollama",
  "lm-studio",
  "llama-cpp",
  "vllm",
  "tgi",
  "text-generation-inference",
  "sglang",
  "xinference",
]);
const DASHBOARD_IMAGE_VIDEO_PROVIDER_IDS = new Set([
  "stability-ai",
  "black-forest-labs",
  "ideogram",
  "luma-ai",
  "runway",
  "pika",
  "replicate",
  "fal-ai",
]);
const DASHBOARD_SPEECH_PROVIDER_IDS = new Set([
  "elevenlabs",
  "deepgram",
  "assemblyai",
  "cartesia",
  "speechmatics",
]);
const DASHBOARD_EMBEDDING_RERANK_PROVIDER_IDS = new Set([
  "cohere",
  "voyage",
  "jina",
]);
const DASHBOARD_HOMEPAGE_URLS: Record<string, string> = {
  openai: "https://openai.com",
  anthropic: "https://www.anthropic.com",
  "google-gemini": "https://ai.google.dev",
  "google-vertex": "https://cloud.google.com/vertex-ai",
  "azure-openai":
    "https://azure.microsoft.com/products/ai-services/openai-service",
  openrouter: "https://openrouter.ai",
  "aws-bedrock": "https://aws.amazon.com/bedrock",
  "alibaba-qwen": "https://www.alibabacloud.com/product/modelstudio",
  "baidu-qianfan": "https://cloud.baidu.com/product/wenxinworkshop",
  "volcengine-ark": "https://www.volcengine.com/product/ark",
  zhipu: "https://www.bigmodel.cn",
  moonshot: "https://www.moonshot.cn",
  "tencent-hunyuan": "https://hunyuan.tencent.com",
  "01ai": "https://www.01.ai",
  huggingface: "https://huggingface.co",
  "cloudflare-workers-ai": "https://developers.cloudflare.com/workers-ai",
  "stability-ai": "https://stability.ai",
  "black-forest-labs": "https://blackforestlabs.ai",
  "fal-ai": "https://fal.ai",
  "luma-ai": "https://lumalabs.ai",
  runway: "https://runwayml.com",
  pika: "https://pika.art",
  elevenlabs: "https://elevenlabs.io",
  deepgram: "https://deepgram.com",
  assemblyai: "https://www.assemblyai.com",
  cartesia: "https://cartesia.ai",
  speechmatics: "https://www.speechmatics.com",
};

type DashboardCatalogContext = {
  canonicalById: Map<string, CatalogCanonicalModel>;
  canonicalByProjectionKey: Map<string, CatalogCanonicalModel>;
};

function buildDashboardCatalogContext(
  internal: CatalogInternalMaterialization | undefined,
): DashboardCatalogContext {
  const canonicalRegistry = internal?.canonical_registry;
  const canonicalModels = canonicalRegistry?.models || [];
  const canonicalById = new Map(
    canonicalModels.map((model) => [model.canonical_id, model] as const),
  );
  const canonicalByProjectionKey = new Map<string, CatalogCanonicalModel>();
  if (canonicalRegistry?.models.length) {
    for (const binding of buildCanonicalProjectionBindings({
      canonicalRegistry,
      providers: BUILTIN_PROVIDER_CATALOG,
    })) {
      const canonical = canonicalById.get(binding.canonical_id);
      if (!canonical) continue;
      canonicalByProjectionKey.set(
        dashboardProjectionKey(binding.provider_id, binding.model_id),
        canonical,
      );
    }
  }
  return {
    canonicalById,
    canonicalByProjectionKey,
  };
}

function dashboardProjectionKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

function toDashboardCatalogProvider(
  provider: CatalogProvider,
  context: DashboardCatalogContext,
) {
  const endpoints = withDashboardEndpointAliases(provider.endpoints);
  const protocols = DASHBOARD_PROTOCOLS.filter(
    (protocol) => endpoints[protocol],
  );
  const models = provider.models.map((model) =>
    toDashboardCatalogModel(model, provider, context),
  );
  const recommendations = dashboardRecommendedModelBuckets(models);
  const modalities = Array.from(
    new Set(models.flatMap((model) => model.modalities as string[])),
  );
  const pricing = provider.pricing ||
    firstModelPricing(provider) || {
      source: "model-level",
      last_updated: "",
      manual_review_required: true,
    };
  const pricingCoverage = dashboardProviderPricingCoverage(
    models,
    recommendations.recommended_models,
  );
  const pricingTrustSummary = dashboardProviderPricingTrustSummary(
    models,
    pricingCoverage,
  );
  const providerType = deriveDashboardProviderType(provider, modalities);
  const family = deriveDashboardProviderFamily(
    provider,
    providerType,
    modalities,
  );
  const providerStatus = provider.status || "active";
  const defaultVisible = includeDashboardProvider(provider, false);

  return {
    ...provider,
    provider_id: provider.id,
    display_name: provider.name,
    description: `${provider.name} provider preset`,
    status: providerStatus,
    provider_status: providerStatus,
    default_visible: defaultVisible,
    replacement_provider_id: provider.replacement_provider_id,
    replacement_note: provider.replacement_provider_id
      ? provider.status_reason
      : undefined,
    status_reason: provider.status_reason,
    compatibility_profiles: provider.compatibility_profiles || [],
    base_url_matchers: baseUrlMatchers(provider.base_url),
    protocols: protocols.length > 0 ? protocols : ["chat_completions"],
    default_protocol: protocols[0] || "chat_completions",
    endpoints,
    modalities,
    input_types: inferDashboardInputTypes(modalities),
    output_types: inferDashboardOutputTypes(modalities),
    aliases: deriveDashboardProviderAliases(provider),
    family,
    category: family,
    provider_type: providerType,
    compatibility_profile: deriveDashboardCompatibilityProfile(
      provider,
      providerType,
    ),
    logo_id: provider.id,
    homepage_url: dashboardProviderHomepage(provider),
    docs_url: dashboardProviderDocsUrl(provider),
    pricing_url: pricing.source_url || dashboardProviderDocsUrl(provider),
    model_buckets: dashboardProviderModelBuckets(models),
    recommended_model_buckets: recommendations.buckets,
    latest_model_hints: recommendations.latest_model_hints,
    recommended_models: recommendations.recommended_models,
    limits: dashboardProviderLimits(models),
    pricing_units:
      pricing.units || (pricing.unit ? { default: pricing.unit } : {}),
    pricing,
    tags: [provider.source, ...(provider.overridden ? ["override"] : [])],
    canonical_model_coverage: dashboardProviderCanonicalCoverage(models),
    pricing_coverage: pricingCoverage,
    pricing_trust_summary: pricingTrustSummary,
    enrichment_summary: dashboardProviderEnrichmentSummary(models),
    allows_unknown_models:
      provider.id === "openai-compatible" || provider.status === "custom",
    manual_review_required:
      pricingTrustSummary.estimate_ready_models === 0 &&
      (pricing.manual_review_required ||
        models.some((model) => model.pricing_trust === "review_required")),
    pricing_hygiene: assessCatalogPricing(pricing, modalities),
    models,
  };
}

function includeDashboardProvider(
  provider: CatalogProvider,
  showLegacy: boolean,
) {
  if (showLegacy) {
    return shouldExposeProviderWithLegacyToggle(provider.status);
  }
  return shouldExposeProviderByDefault(provider.status);
}

function parseBooleanQuery(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function toDashboardCatalogModel(
  model: CatalogModel,
  provider?: CatalogProvider,
  context?: DashboardCatalogContext,
) {
  const endpointMap = withDashboardEndpointAliases(model.endpoints);
  const endpoints = Object.keys(endpointMap);
  const canonical = dashboardCanonicalModel(model, provider, context);
  const canonicalId = dashboardCanonicalId(model, canonical);
  const pricing = model.pricing ||
    firstModelPricing(provider) || {
      source: "missing",
      last_updated: "",
      manual_review_required: true,
    };
  const pricingSources = dashboardModelPricingSources(model, canonical);
  const pricingTrust = dashboardModelPricingTrust({
    canonicalId,
    matchConfidence: model.enrichment?.match_confidence,
    pricing,
  });
  return {
    ...model,
    name: model.display_name || model.id,
    provider_id: model.provider,
    endpoints,
    input_types: inferDashboardInputTypes(model.modalities),
    output_types: inferDashboardOutputTypes(model.modalities),
    canonical_id: canonicalId,
    projection_source: dashboardModelProjectionSource(model, canonical),
    lifecycle: dashboardModelLifecycle(model, canonical),
    specs: dashboardModelSpecs(model, canonical),
    benchmarks: dashboardModelBenchmarks(model, canonical),
    match_strategy: model.enrichment?.match_strategy,
    match_confidence: model.enrichment?.match_confidence,
    pricing_sources: pricingSources,
    pricing,
    pricing_trust: pricingTrust,
    pricing_hygiene: assessCatalogPricing(pricing, model.modalities),
    manual_review_required: pricing.manual_review_required,
  };
}

function firstModelPricing(provider: CatalogProvider | undefined) {
  return provider?.models.find((model) => model.pricing)?.pricing;
}

function deriveDashboardProviderAliases(provider: CatalogProvider): string[] {
  return Array.from(
    new Set(
      [
        provider.id,
        provider.name,
        ...(provider.model_prefixes || []),
        ...(provider.capabilities || []),
        ...(DASHBOARD_PROVIDER_ALIAS_HINTS[provider.id] || []),
      ]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function deriveDashboardProviderType(
  provider: CatalogProvider,
  modalities: string[],
): DashboardProviderType {
  const id = provider.id.toLowerCase();
  const baseUrl = provider.base_url.toLowerCase();
  if (provider.status === "custom" || id === "openai-compatible")
    return "custom";
  if (provider.provider_type) return provider.provider_type;
  if (
    DASHBOARD_LOCAL_PROVIDER_IDS.has(id) ||
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1")
  )
    return "local";
  if (DASHBOARD_AGGREGATOR_PROVIDER_IDS.has(id)) return "aggregator";
  if (DASHBOARD_CLOUD_PROVIDER_IDS.has(id)) return "cloud";
  if (
    DASHBOARD_SPEECH_PROVIDER_IDS.has(id) ||
    (modalities.includes("audio") && !modalities.includes("text"))
  )
    return "speech";
  if (
    DASHBOARD_IMAGE_VIDEO_PROVIDER_IDS.has(id) ||
    ((modalities.includes("image") || modalities.includes("video")) &&
      !modalities.includes("text"))
  )
    return "media";
  if (
    provider.capabilities?.some(
      (capability) =>
        capability.includes("openai-compatible") ||
        capability.includes("openai_compatible"),
    ) ||
    provider.model_prefixes?.some((prefix) => prefix.includes("/")) ||
    provider.id.endsWith("-compatible")
  ) {
    return "compatible";
  }
  return "direct";
}

function deriveDashboardProviderFamily(
  provider: CatalogProvider,
  providerType: DashboardProviderType,
  modalities: string[],
): DashboardProviderFamily {
  const id = provider.id.toLowerCase();
  if (DASHBOARD_CHINA_PROVIDER_IDS.has(id)) return "china";
  if (providerType === "aggregator") return "aggregators";
  if (providerType === "cloud") return "cloud";
  if (providerType === "local" || providerType === "self_hosted")
    return "self_hosted";
  if (
    DASHBOARD_IMAGE_VIDEO_PROVIDER_IDS.has(id) ||
    modalities.includes("video") ||
    (modalities.includes("image") && !modalities.includes("text"))
  ) {
    return "image_video";
  }
  if (
    DASHBOARD_SPEECH_PROVIDER_IDS.has(id) ||
    (modalities.includes("audio") && !modalities.includes("text"))
  ) {
    return "speech_audio";
  }
  if (
    DASHBOARD_EMBEDDING_RERANK_PROVIDER_IDS.has(id) ||
    (modalities.every((modality) =>
      ["embedding", "rerank", "text"].includes(modality),
    ) &&
      (modalities.includes("embedding") || modalities.includes("rerank")))
  ) {
    return "embedding_rerank";
  }
  return "foundation";
}

function deriveDashboardCompatibilityProfile(
  provider: CatalogProvider,
  providerType: DashboardProviderType,
): DashboardCompatibilityProfile {
  const id = provider.id.toLowerCase();
  if (id === "openai-compatible" || providerType === "custom") return "custom";
  if (providerType === "local") return "local";
  if (id.includes("anthropic") || provider.endpoints.messages)
    return "anthropic-compatible";
  if (id.includes("gemini") || id.includes("vertex"))
    return "google-compatible";
  if (
    provider.endpoints.chat_completions ||
    provider.endpoints.responses ||
    provider.capabilities?.some(
      (capability) =>
        capability.includes("openai-compatible") ||
        capability.includes("openai_compatible"),
    ) ||
    [
      "openrouter",
      "groq",
      "mistral",
      "deepseek",
      "xai",
      "together",
      "fireworks",
      "ollama",
      "vllm",
    ].includes(id)
  ) {
    return "openai-compatible";
  }
  return "native";
}

function dashboardProviderHomepage(provider: CatalogProvider): string | null {
  if (DASHBOARD_HOMEPAGE_URLS[provider.id])
    return DASHBOARD_HOMEPAGE_URLS[provider.id];
  try {
    const url = new URL(provider.base_url);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return null;
  }
}

function usesGoogleApiKeyHeader(protocol: string, baseUrl: string): boolean {
  return (
    protocol === "gemini" ||
    baseUrl.toLowerCase().includes("generativelanguage.googleapis.com")
  );
}

function dashboardProviderDocsUrl(provider: CatalogProvider): string | null {
  return provider.pricing?.source_url || dashboardProviderHomepage(provider);
}

function dashboardProviderModelBuckets(
  models: ReturnType<typeof toDashboardCatalogModel>[],
): Record<DashboardModelBucket, string[]> {
  const buckets = Object.fromEntries(
    DASHBOARD_MODEL_BUCKETS.map((bucket) => [bucket, [] as string[]]),
  ) as Record<DashboardModelBucket, string[]>;
  for (const model of models) {
    for (const bucket of dashboardBucketsForModel(model)) {
      buckets[bucket].push(model.id);
    }
  }
  return buckets;
}

function dashboardBucketsForModel(
  model: ReturnType<typeof toDashboardCatalogModel>,
): DashboardModelBucket[] {
  const buckets: DashboardModelBucket[] = [];
  if (
    model.endpoints.includes("embeddings") ||
    model.modalities.includes("embedding")
  )
    buckets.push("embedding_models");
  if (model.endpoints.includes("rerank") || model.modalities.includes("rerank"))
    buckets.push("rerank_models");
  if (
    model.endpoints.includes("chat_completions") ||
    model.endpoints.includes("responses") ||
    model.endpoints.includes("messages") ||
    model.modalities.includes("text") ||
    model.modalities.includes("vision")
  )
    buckets.push("models");
  if (
    model.endpoints.includes("image_generations") ||
    model.endpoints.includes("image_edits") ||
    model.modalities.includes("image")
  )
    buckets.push("image_models");
  if (
    model.endpoints.includes("audio_transcriptions") ||
    model.endpoints.includes("audio_speech") ||
    model.modalities.includes("audio")
  )
    buckets.push("audio_models");
  if (
    model.endpoints.includes("video_generations") ||
    model.endpoints.includes("video_status") ||
    model.modalities.includes("video")
  )
    buckets.push("video_models");
  if (
    model.endpoints.includes("realtime") ||
    model.modalities.includes("realtime")
  )
    buckets.push("realtime_models");
  if (model.modalities.includes("batch")) buckets.push("batch_models");
  return [...new Set(buckets)];
}

function dashboardRecommendedModelBuckets(
  models: ReturnType<typeof toDashboardCatalogModel>[],
): {
  buckets: Record<DashboardModelBucket, string[]>;
  latest_model_hints: Partial<
    Record<
      DashboardModelBucket,
      {
        primary_model: string;
        release_date?: string;
        has_pricing: boolean;
        source: "recommended" | "fallback";
      }
    >
  >;
  recommended_models: Array<{
    bucket: DashboardModelBucket;
    model_id: string;
    release_date?: string;
    has_pricing: boolean;
    source: "recommended" | "fallback";
  }>;
} {
  const buckets = Object.fromEntries(
    DASHBOARD_MODEL_BUCKETS.map((bucket) => [bucket, [] as string[]]),
  ) as Record<DashboardModelBucket, string[]>;
  const latestModelHints: Partial<
    Record<
      DashboardModelBucket,
      {
        primary_model: string;
        release_date?: string;
        has_pricing: boolean;
        source: "recommended" | "fallback";
      }
    >
  > = {};
  const recommendedModels: Array<{
    bucket: DashboardModelBucket;
    model_id: string;
    release_date?: string;
    has_pricing: boolean;
    source: "recommended" | "fallback";
  }> = [];

  for (const bucket of DASHBOARD_MODEL_BUCKETS) {
    const bucketModels = models.filter((model) =>
      dashboardBucketsForModel(model).includes(bucket),
    );
    const recommended = recommendModelsForBucket(
      bucketModels,
      DASHBOARD_RECOMMENDED_MODEL_LIMITS[bucket],
    );
    buckets[bucket] = recommended.models.map((model) => model.id);
    if (recommended.models.length === 0) continue;
    const primary = recommended.models[0];
    const primaryHasPricing = dashboardModelHasPricing(primary);
    latestModelHints[bucket] = {
      primary_model: primary.id,
      release_date: dashboardModelReleaseDate(primary) || undefined,
      has_pricing: primaryHasPricing,
      source: recommended.source,
    };
    for (const model of recommended.models) {
      const hasPricing = dashboardModelHasPricing(model);
      recommendedModels.push({
        bucket,
        model_id: model.id,
        release_date: dashboardModelReleaseDate(model) || undefined,
        has_pricing: hasPricing,
        source: recommended.source,
      });
    }
  }

  return {
    buckets,
    latest_model_hints: latestModelHints,
    recommended_models: recommendedModels,
  };
}

function recommendModelsForBucket(
  models: ReturnType<typeof toDashboardCatalogModel>[],
  limit: number,
): {
  models: ReturnType<typeof toDashboardCatalogModel>[];
  source: "recommended" | "fallback";
} {
  const eligibleModels = models.filter(
    (model) => !dashboardModelIsLowConfidence(model),
  );
  if (eligibleModels.length === 0) {
    return { models: [], source: "fallback" };
  }

  const hasEnrichmentSignals = eligibleModels.some((model) =>
    Boolean(
      dashboardModelReleaseDate(model) ||
      model.enrichment?.canonical_model_id ||
      model.enrichment?.organization_id ||
      model.enrichment?.enriched_from,
    ),
  );

  if (!hasEnrichmentSignals) {
    return {
      models: eligibleModels.slice(0, limit),
      source: "fallback",
    };
  }

  const stableRanked = dedupeRecommendedModelFamilies(
    eligibleModels
      .filter((model) => !dashboardModelIsPreview(model))
      .sort(compareRecommendedModels),
  ).slice(0, limit);

  if (stableRanked.length > 0) {
    return {
      models: stableRanked,
      source: "recommended",
    };
  }

  return {
    models: dedupeRecommendedModelFamilies(
      [...eligibleModels].sort(compareRecommendedModels),
    ).slice(0, limit),
    source: "fallback",
  };
}

function dedupeRecommendedModelFamilies(
  models: ReturnType<typeof toDashboardCatalogModel>[],
): ReturnType<typeof toDashboardCatalogModel>[] {
  const seenFamilies = new Set<string>();
  const selected: ReturnType<typeof toDashboardCatalogModel>[] = [];
  for (const model of models) {
    const familyKey = dashboardModelFamilyKey(model);
    if (seenFamilies.has(familyKey)) continue;
    seenFamilies.add(familyKey);
    selected.push(model);
  }
  return selected;
}

function compareRecommendedModels(
  left: ReturnType<typeof toDashboardCatalogModel>,
  right: ReturnType<typeof toDashboardCatalogModel>,
): number {
  const rightRelease = dashboardModelReleaseTimestamp(right);
  const leftRelease = dashboardModelReleaseTimestamp(left);
  if (rightRelease !== leftRelease) return rightRelease - leftRelease;

  const rightPricing = Number(dashboardModelHasPricing(right));
  const leftPricing = Number(dashboardModelHasPricing(left));
  if (rightPricing !== leftPricing) return rightPricing - leftPricing;

  const rightSource = dashboardModelSourcePriority(right);
  const leftSource = dashboardModelSourcePriority(left);
  if (rightSource !== leftSource) return rightSource - leftSource;

  const rightEnrichment = Number(Boolean(right.enrichment));
  const leftEnrichment = Number(Boolean(left.enrichment));
  if (rightEnrichment !== leftEnrichment)
    return rightEnrichment - leftEnrichment;

  return (left.display_name || left.name || left.id).localeCompare(
    right.display_name || right.name || right.id,
  );
}

function dashboardModelReleaseDate(
  model: ReturnType<typeof toDashboardCatalogModel>,
): string | null {
  if (dashboardModelIsLowConfidence(model)) return null;
  return (
    model.enrichment?.lifecycle?.release_date ||
    model.enrichment?.release_date ||
    model.enrichment?.lifecycle?.announcement_date ||
    model.enrichment?.announcement_date ||
    null
  );
}

function dashboardModelReleaseTimestamp(
  model: ReturnType<typeof toDashboardCatalogModel>,
): number {
  const releaseDate = dashboardModelReleaseDate(model);
  if (!releaseDate) return -Infinity;
  const parsed = Date.parse(releaseDate);
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

function dashboardModelHasPricing(
  model: ReturnType<typeof toDashboardCatalogModel>,
): boolean {
  if (model.pricing_trust === "missing") return false;
  return dashboardPricingHasAnyValue(model.pricing);
}

function dashboardPricingHasAnyValue(
  pricing: CatalogPricing | undefined,
): boolean {
  const reference: Partial<CatalogPricing> = pricing || {};
  return [
    reference.input,
    reference.output,
    reference.input_per_1m_tokens,
    reference.output_per_1m_tokens,
    reference.cache_read_input,
    reference.cache_creation_input,
    reference.cache_read_per_1m_tokens,
    reference.cache_write_per_1m_tokens,
    reference.embedding,
    reference.embedding_per_1m_tokens,
    reference.rerank,
    reference.rerank_per_1k_requests,
    reference.rerank_per_1k_docs,
    reference.image,
    reference.image_per_generation,
    reference.image_per_edit,
    reference.audio,
    reference.audio_per_minute,
    reference.audio_per_1m_chars,
    reference.video,
    reference.video_per_second,
    reference.video_per_generation,
    reference.realtime_per_minute,
  ].some((value) => typeof value === "number" && Number.isFinite(value));
}

function dashboardModelPricingTrust(input: {
  pricing: CatalogPricing | undefined;
  canonicalId?: string;
  matchConfidence?: "high" | "medium" | "low";
}): DashboardPricingTrustStatus {
  const { pricing, canonicalId, matchConfidence } = input;
  if (!pricing) return "missing";
  const hasNumericPricing = dashboardPricingHasAnyValue(pricing);
  const source = pricing.source || "";
  if (source === "missing") return "missing";
  const confidence = matchConfidence || pricing.pricing_confidence;
  const hasReviewSource =
    source === "operator_required" ||
    source === "provider_docs" ||
    source === "docs_review" ||
    pricing.source_type === "docs_review" ||
    Boolean(pricing.source_url) ||
    Boolean(pricing.review_reason) ||
    pricing.manual_review_required;

  if (!hasNumericPricing)
    return hasReviewSource ? "review_required" : "missing";

  if (
    source === "openrouter-public-api" &&
    Boolean(canonicalId) &&
    matchConfidence !== "low"
  ) {
    return "aligned_estimate";
  }

  if (source === "zeroeval") {
    return confidence === "high" || confidence === "medium"
      ? "reference_estimate"
      : "review_required";
  }

  if (
    source === "builtin-reference" ||
    source === "builtin-static-placeholder" ||
    source === "manual_placeholder" ||
    source === "provider-reference" ||
    source === "provider_docs" ||
    source === "docs_review" ||
    pricing.source_type === "official_docs" ||
    pricing.source_type === "docs_review"
  ) {
    return "reference_estimate";
  }

  if (source === "operator_required") return "review_required";
  if (
    pricing.pricing_confidence === "low" ||
    pricing.pricing_confidence === "unknown"
  ) {
    return "review_required";
  }
  return "reference_estimate";
}

function dashboardModelSourcePriority(
  model: ReturnType<typeof toDashboardCatalogModel>,
): number {
  if (model.source === "override") return 3;
  if (model.source === "sync_cache") return 2;
  return 1;
}

function dashboardModelIsLowConfidence(
  model: ReturnType<typeof toDashboardCatalogModel>,
): boolean {
  return model.enrichment?.match_confidence === "low";
}

function dashboardModelIsPreview(
  model: ReturnType<typeof toDashboardCatalogModel>,
): boolean {
  const value = [
    model.id,
    model.display_name,
    model.name,
    model.enrichment?.canonical_model_id,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" ")
    .toLowerCase();
  return /\b(preview|snapshot|beta|alpha|experimental|exp|canary|nightly)\b/.test(
    value,
  );
}

function dashboardModelFamilyKey(
  model: ReturnType<typeof toDashboardCatalogModel>,
): string {
  const source = (
    model.enrichment?.canonical_model_id ||
    model.display_name ||
    model.name ||
    model.id
  ).toLowerCase();
  return (
    source
      .replace(/20\d{2}[-_./]?\d{2}[-_./]?\d{2}/g, " ")
      .replace(
        /\b(preview|snapshot|beta|alpha|experimental|exp|canary|nightly|latest|stable|thinking|non-thinking|dated)\b/g,
        " ",
      )
      .replace(/(^|[\s\-_/])\d+(?:\.\d+)*(?=$|[\s\-_/])/g, " ")
      .replace(/[-_/:]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || model.id.toLowerCase()
  );
}

function dashboardProviderLimits(
  models: ReturnType<typeof toDashboardCatalogModel>[],
): {
  model_count: number;
  max_context_tokens: number | null;
  max_file_size: number | null;
} {
  const maxContext = Math.max(
    0,
    ...models.map((model) => model.limits?.max_context_tokens || 0),
  );
  const maxFileSize = Math.max(
    0,
    ...models.map((model) => model.limits?.max_file_size || 0),
  );
  return {
    model_count: models.length,
    max_context_tokens: maxContext || null,
    max_file_size: maxFileSize || null,
  };
}

function dashboardProviderEnrichmentSummary(
  models: ReturnType<typeof toDashboardCatalogModel>[],
):
  | {
      enriched_model_count: number;
      benchmarked_model_count: number;
      latest_enriched_at: string | null;
      sources: string[];
    }
  | undefined {
  const enrichedModels = models.filter((model) => model.enrichment);
  if (enrichedModels.length === 0) return undefined;
  const benchmarkedModelCount = enrichedModels.filter(
    (model) =>
      model.enrichment?.benchmarks &&
      Object.keys(model.enrichment.benchmarks).length > 0,
  ).length;
  const latestEnrichedAt = latestCatalogEnrichmentTimestamp(
    enrichedModels
      .map(
        (model) =>
          model.enrichment?.enriched_at || model.enrichment?.synced_at || null,
      )
      .filter((value): value is string => Boolean(value)),
  );
  const sources = Array.from(
    new Set(
      enrichedModels
        .map(
          (model) =>
            model.enrichment?.enriched_from || model.enrichment?.source || null,
        )
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort();
  return {
    enriched_model_count: enrichedModels.length,
    benchmarked_model_count: benchmarkedModelCount,
    latest_enriched_at: latestEnrichedAt,
    sources,
  };
}

function dashboardProviderCanonicalCoverage(
  models: ReturnType<typeof toDashboardCatalogModel>[],
): {
  total_models: number;
  canonicalized_models: number;
  projected_models: number;
  enriched_models: number;
  benchmarked_models: number;
  low_confidence_models: number;
  coverage_ratio: number;
} {
  const totalModels = models.length;
  const canonicalizedModels = models.filter((model) =>
    Boolean(model.canonical_id),
  ).length;
  const projectedModels = models.filter(
    (model) => model.projection_source === "canonical_projection",
  ).length;
  const enrichedModels = models.filter((model) =>
    Boolean(model.enrichment),
  ).length;
  const benchmarkedModels = models.filter(
    (model) => model.benchmarks && Object.keys(model.benchmarks).length > 0,
  ).length;
  const lowConfidenceModels = models.filter(
    (model) => model.match_confidence === "low",
  ).length;
  return {
    total_models: totalModels,
    canonicalized_models: canonicalizedModels,
    projected_models: projectedModels,
    enriched_models: enrichedModels,
    benchmarked_models: benchmarkedModels,
    low_confidence_models: lowConfidenceModels,
    coverage_ratio: totalModels > 0 ? canonicalizedModels / totalModels : 0,
  };
}

function dashboardProviderPricingCoverage(
  models: ReturnType<typeof toDashboardCatalogModel>[],
  recommendedModels: Array<{
    bucket: DashboardModelBucket;
    model_id: string;
    release_date?: string;
    has_pricing: boolean;
    source: "recommended" | "fallback";
  }>,
): {
  total_models: number;
  priced_models: number;
  recommended_models: number;
  recommended_priced_models: number;
  manual_review_required_priced_models: number;
  estimate_ready_models: number;
  aligned_estimate_models: number;
  reference_estimate_models: number;
  review_required_models: number;
  missing_models: number;
  coverage_ratio: number;
} {
  const totalModels = models.length;
  const pricedModels = models.filter((model) =>
    dashboardModelHasPricing(model),
  ).length;
  const alignedEstimateModels = models.filter(
    (model) => model.pricing_trust === "aligned_estimate",
  ).length;
  const referenceEstimateModels = models.filter(
    (model) => model.pricing_trust === "reference_estimate",
  ).length;
  const reviewRequiredModels = models.filter(
    (model) => model.pricing_trust === "review_required",
  ).length;
  const missingModels = models.filter(
    (model) => model.pricing_trust === "missing",
  ).length;
  const estimateReadyModels = alignedEstimateModels + referenceEstimateModels;
  const recommendedIds = new Set(
    recommendedModels.map((entry) => entry.model_id),
  );
  const recommendedPricedModels = models.filter(
    (model) => recommendedIds.has(model.id) && dashboardModelHasPricing(model),
  ).length;
  const manualReviewRequiredPricedModels = models.filter(
    (model) =>
      dashboardModelHasPricing(model) &&
      Boolean(model.pricing?.manual_review_required),
  ).length;
  return {
    total_models: totalModels,
    priced_models: pricedModels,
    recommended_models: recommendedIds.size,
    recommended_priced_models: recommendedPricedModels,
    manual_review_required_priced_models: manualReviewRequiredPricedModels,
    estimate_ready_models: estimateReadyModels,
    aligned_estimate_models: alignedEstimateModels,
    reference_estimate_models: referenceEstimateModels,
    review_required_models: reviewRequiredModels,
    missing_models: missingModels,
    coverage_ratio: totalModels > 0 ? pricedModels / totalModels : 0,
  };
}

function dashboardProviderPricingTrustSummary(
  models: ReturnType<typeof toDashboardCatalogModel>[],
  coverage: ReturnType<typeof dashboardProviderPricingCoverage>,
): {
  status: DashboardPricingTrustStatus;
  total_models: number;
  estimate_ready_models: number;
  aligned_estimate_models: number;
  reference_estimate_models: number;
  review_required_models: number;
  missing_models: number;
} {
  let status: DashboardPricingTrustStatus = "missing";
  if (coverage.aligned_estimate_models > 0) status = "aligned_estimate";
  else if (coverage.reference_estimate_models > 0)
    status = "reference_estimate";
  else if (coverage.review_required_models > 0) status = "review_required";
  else if (models.length === 0) status = "missing";
  return {
    status,
    total_models: coverage.total_models,
    estimate_ready_models: coverage.estimate_ready_models,
    aligned_estimate_models: coverage.aligned_estimate_models,
    reference_estimate_models: coverage.reference_estimate_models,
    review_required_models: coverage.review_required_models,
    missing_models: coverage.missing_models,
  };
}

function dashboardCanonicalModel(
  model: CatalogModel,
  provider: CatalogProvider | undefined,
  context: DashboardCatalogContext | undefined,
): CatalogCanonicalModel | undefined {
  if (!context) return undefined;
  const explicitCanonicalId = model.enrichment?.canonical_model_id;
  if (explicitCanonicalId) {
    const explicitCanonical = context.canonicalById.get(explicitCanonicalId);
    if (explicitCanonical) return explicitCanonical;
  }
  const providerId = provider?.id || model.provider;
  return context.canonicalByProjectionKey.get(
    dashboardProjectionKey(providerId, model.id),
  );
}

function dashboardCanonicalId(
  model: CatalogModel,
  canonical: CatalogCanonicalModel | undefined,
): string | undefined {
  return model.enrichment?.canonical_model_id || canonical?.canonical_id;
}

function dashboardModelProjectionSource(
  model: CatalogModel,
  canonical: CatalogCanonicalModel | undefined,
): "canonical_projection" | "catalog_override" | "sync_cache" | "builtin" {
  if (canonical && model.synced) return "canonical_projection";
  if (model.overridden) return "catalog_override";
  if (model.synced) return "sync_cache";
  return "builtin";
}

function dashboardModelLifecycle(
  model: CatalogModel,
  canonical: CatalogCanonicalModel | undefined,
):
  | {
      release_date?: string;
      announcement_date?: string;
      knowledge_cutoff?: string;
    }
  | undefined {
  const lifecycle = {
    ...(canonical?.enrichment?.lifecycle || {}),
    ...(model.enrichment?.lifecycle || {}),
  };
  lifecycle.release_date ||=
    model.enrichment?.release_date || canonical?.enrichment?.release_date;
  lifecycle.announcement_date ||=
    model.enrichment?.announcement_date ||
    canonical?.enrichment?.announcement_date;
  return Object.values(lifecycle).some(Boolean) ? lifecycle : undefined;
}

function dashboardModelSpecs(
  model: CatalogModel,
  canonical: CatalogCanonicalModel | undefined,
):
  | {
      params?: number;
      training_tokens?: number;
      throughput?: number;
      multimodal?: boolean;
      license?: string;
      is_moe?: boolean;
    }
  | undefined {
  const specs = {
    ...(canonical?.enrichment?.specs || {}),
    ...(model.enrichment?.specs || {}),
  };
  if (specs.throughput === undefined) {
    specs.throughput =
      model.enrichment?.throughput || canonical?.enrichment?.throughput;
  }
  if (specs.multimodal === undefined) {
    specs.multimodal =
      model.enrichment?.multimodal ?? canonical?.enrichment?.multimodal;
  }
  return Object.values(specs).some((value) => value !== undefined)
    ? specs
    : undefined;
}

function dashboardModelBenchmarks(
  model: CatalogModel,
  canonical: CatalogCanonicalModel | undefined,
): Record<string, number> | undefined {
  return (
    (model.enrichment?.benchmarks
      ? { ...model.enrichment.benchmarks }
      : undefined) ||
    (canonical?.enrichment?.benchmarks
      ? { ...canonical.enrichment.benchmarks }
      : undefined)
  );
}

function dashboardPricingSourceSummary(
  pricing: CatalogPricing | undefined,
  hasPricing: (
    pricing: CatalogPricing | undefined,
  ) => boolean = dashboardPricingHasAnyValue,
):
  | {
      source: string;
      source_type: string | null;
      source_url: string | null;
      pricing_confidence: string | null;
      manual_review_required: boolean;
      last_updated: string | null;
      retrieved_at: string | null;
      last_verified_at: string | null;
      has_pricing: boolean;
    }
  | undefined {
  if (!pricing) return undefined;
  return {
    source: pricing.source,
    source_type: pricing.source_type || null,
    source_url: pricing.source_url || null,
    pricing_confidence: pricing.pricing_confidence || null,
    manual_review_required: pricing.manual_review_required,
    last_updated: pricing.last_updated || null,
    retrieved_at: pricing.retrieved_at || null,
    last_verified_at: pricing.last_verified_at || null,
    has_pricing: hasPricing(pricing),
  };
}

function dashboardModelPricingSources(
  model: CatalogModel,
  canonical: CatalogCanonicalModel | undefined,
): {
  effective: ReturnType<typeof dashboardPricingSourceSummary> | undefined;
  primary_reference:
    | ReturnType<typeof dashboardPricingSourceSummary>
    | undefined;
  secondary_reference:
    | ReturnType<typeof dashboardPricingSourceSummary>
    | undefined;
  effective_source: string | null;
  primary_reference_source: string | null;
  secondary_reference_source: string | null;
} {
  const effective = dashboardPricingSourceSummary(
    model.pricing,
    (pricing) =>
      dashboardModelPricingTrust({
        pricing,
        canonicalId: dashboardCanonicalId(model, canonical),
        matchConfidence: model.enrichment?.match_confidence,
      }) !== "missing" && dashboardPricingHasAnyValue(pricing),
  );
  const primaryReference = dashboardPricingSourceSummary(
    canonical?.pricing_reference,
  );
  const secondaryReference = dashboardPricingSourceSummary(
    model.enrichment?.secondary_pricing_reference,
  );
  return {
    effective,
    primary_reference: primaryReference,
    secondary_reference: secondaryReference,
    effective_source: effective?.source || null,
    primary_reference_source: primaryReference?.source || null,
    secondary_reference_source: secondaryReference?.source || null,
  };
}

function latestCatalogEnrichmentTimestamp(values: string[]): string | null {
  if (values.length === 0) return null;
  let latestValue: string | null = null;
  let latestTime = -Infinity;
  for (const value of values) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed) && parsed > latestTime) {
      latestTime = parsed;
      latestValue = value;
    }
  }
  return latestValue;
}

function withDashboardEndpointAliases(
  endpoints: Partial<Record<string, string>> | undefined,
): Partial<Record<string, string>> {
  const next = { ...(endpoints || {}) };
  if (next.image) {
    next.image_generations ??= next.image;
    next.image_edits ??= next.image;
  }
  if (next.audio) {
    next.audio_transcriptions ??= next.audio;
    next.audio_speech ??= next.audio;
  }
  if (next.video) {
    next.video_generations ??= next.video;
  }
  return next;
}

function inferDashboardInputTypes(
  modalities: readonly Modality[] | readonly string[],
): string[] {
  const values = new Set<string>();
  for (const modality of modalities) {
    if (
      modality === "text" ||
      modality === "vision" ||
      modality === "embedding" ||
      modality === "rerank"
    ) {
      values.add("text");
    }
    if (modality === "vision" || modality === "image") values.add("image");
    if (modality === "audio") values.add("audio");
    if (modality === "video") values.add("video");
    if (modality === "batch") values.add("file");
    if (modality === "realtime") values.add("events");
  }
  return [...values];
}

function inferDashboardOutputTypes(
  modalities: readonly Modality[] | readonly string[],
): string[] {
  const values = new Set<string>();
  for (const modality of modalities) {
    if (modality === "text" || modality === "vision" || modality === "rerank")
      values.add("text");
    if (modality === "embedding") values.add("embedding");
    if (modality === "image") values.add("image");
    if (modality === "audio") values.add("audio");
    if (modality === "video") values.add("video");
    if (modality === "batch") values.add("file");
    if (modality === "realtime") values.add("events");
  }
  return [...values];
}

function baseUrlMatchers(baseUrl: string): string[] {
  try {
    return [new URL(baseUrl).hostname];
  } catch {
    return [baseUrl];
  }
}

@Controller("api/dashboard")
@UseGuards(DashboardGuard, DashboardRbacGuard)
@ApiTags("Dashboard")
@ApiBearerAuth("dashboardSession")
@ApiUnauthorizedResponse({ type: ErrorEnvelopeDto })
export class DashboardController implements BeforeApplicationShutdown {
  private readonly logger = new Logger(DashboardController.name);
  private readonly statsCache = new Map<
    string,
    { expiresAt: number; value: DashboardStatsResponse }
  >();
  private readonly statsInFlight = new Map<
    string,
    Promise<DashboardStatsResponse>
  >();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private cleanupStopped = false;

  constructor(
    private readonly config: ConfigService,
    private readonly capabilityService: CapabilityService,
    private readonly routingService: RoutingService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly concurrencyLimiter: ConcurrencyLimiterService,
    private readonly activeHealth: ActiveHealthProbeService,
    private readonly budgetService: BudgetService,
    private readonly cacheService: PromptCacheService,
    private readonly logEventBus: LogEventBus,
    private readonly telemetry: TelemetryService,
    private readonly routingRecommendations: RoutingRecommendationService,
    private readonly gatewayApiKeys: GatewayApiKeyService,
    private readonly agentProfiles: AgentProfileService,
    private readonly agentPlatform: AgentPlatformService,
    private readonly teams: TeamService,
    private readonly shadowTraffic: ShadowTrafficService,
    private readonly cacheSavings: CacheSavingsService,
    private readonly providerCompatibility: ProviderCompatibilityService,
    private readonly configAudit: ConfigAuditService,
    private readonly managementAudit: ManagementAuditService,
    private readonly catalog: CatalogService,
    private readonly providerExtensibility: ProviderExtensibilityService,
    private readonly batchJobs: BatchJobStoreService,
    private readonly workspaces: WorkspaceService,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly cluster: ClusterService,
    @Optional()
    @Inject(RealtimeProxyService)
    private readonly realtime: RealtimeProxyService | undefined,
    private readonly dataSource: DataSource,
    @InjectRepository(CallLog)
    private readonly callLogRepo: Repository<CallLog>,
    @InjectRepository(RouteDecisionLog)
    private readonly routeDecisionRepo: Repository<RouteDecisionLog>,
    @InjectRepository(ShadowTrafficResult)
    private readonly shadowTrafficRepo: Repository<ShadowTrafficResult>,
    @Optional()
    @Inject(SecretReferenceResolverService)
    private readonly secretResolver?: SecretReferenceResolverService,
    @Optional()
    @Inject(BenchmarkReportService)
    private readonly benchmarkReports?: BenchmarkReportService,
    @Optional()
    @Inject(PluginRegistryService)
    private readonly plugins?: PluginRegistryService,
    @Optional()
    @Inject(McpGatewayService)
    private readonly mcp?: McpGatewayService,
    @Optional()
    @Inject(WorkspaceMembershipService)
    private readonly memberships?: WorkspaceMembershipService,
    @Optional()
    @Inject(WorkspaceInvitationService)
    private readonly invitations?: WorkspaceInvitationService,
    @Optional()
    @Inject(CredentialPoolService)
    private readonly credentialPool?: CredentialPoolService,
    @Optional()
    private readonly sqliteAnalytics?: SqliteAnalyticsService,
  ) {
    if ((this.config.database.log_retention_days ?? 30) <= 0) {
      this.logger.warn(
        "Automatic call-log retention is disabled; monitor database growth and configure verified backups.",
      );
    }
    this.scheduleCleanup(60_000);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.cleanupStopped = true;
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
  }

  private scheduleCleanup(delayMs: number): void {
    this.cleanupTimer = setTimeout(() => {
      if (this.cleanupStopped) return;
      void this.cleanupOldLogs()
        .catch((error) => {
          this.logger.warn(`Log cleanup failed: ${(error as Error).message}`);
        })
        .finally(() => {
          if (!this.cleanupStopped) this.scheduleCleanup(6 * 60 * 60_000);
        });
    }, delayMs);
    this.cleanupTimer.unref();
  }

  @Get("workspaces")
  @ApiOperation({
    summary: "List current organization and Dashboard workspaces",
  })
  @ApiOkResponse({ type: WorkspaceStateResponseDto })
  async getWorkspaces(
    @Req()
    req: Request & {
      dashboardUserId?: string;
      dashboardRole?: WorkspaceMembershipRole;
      workspaceId?: string;
    },
  ) {
    const userId = req.dashboardUserId || "dashboard";
    const accessibleWorkspaceIds =
      await this.accessibleWorkspaceIdsForUser(userId);
    const currentRole = req.workspaceId
      ? await this.workspaceMemberships().findActiveRole(
          userId,
          req.workspaceId,
        )
      : req.dashboardRole;
    const state = await this.workspaces.getState(
      this.workspaceContext.currentWorkspaceId(),
      {
        includeDisabled: currentRole === "admin",
        workspaceIds: accessibleWorkspaceIds,
      },
    );
    return {
      ...state,
      access: {
        user_id: userId,
        role: currentRole || "viewer",
        permissions: this.dashboardPermissions(currentRole || "viewer"),
      },
    };
  }

  @Post("workspaces/switch")
  @RequireDashboardRole("viewer")
  @ApiOperation({
    summary: "Validate and switch the active Dashboard workspace",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: { workspace_id: { type: "string" } },
      required: ["workspace_id"],
    },
  })
  @ApiOkResponse({
    description:
      "Validated workspace state. The Dashboard persists the selected workspace client-side.",
  })
  async switchWorkspace(
    @Req()
    req: Request & {
      dashboardUserId?: string;
      dashboardRole?: WorkspaceMembershipRole;
    },
    @Body() body: { workspace_id?: string },
  ) {
    const userId = req.dashboardUserId || "dashboard";
    const workspace = await this.workspaces.requireWorkspace(
      body?.workspace_id,
    );
    const targetRole = await this.workspaceMemberships().findActiveRole(
      userId,
      workspace.id,
    );
    if (!targetRole) {
      throw new HttpException(
        {
          error: {
            message: "Requires viewer role for this workspace.",
            type: "dashboard_permission_denied",
            code: "workspace_role_required",
          },
          required_role: "viewer",
          current_role: null,
          workspace_id: workspace.id,
        },
        HttpStatus.FORBIDDEN,
      );
    }
    return {
      success: true,
      active_workspace: workspace,
      state: await this.workspaceStateForDashboard(
        userId,
        targetRole,
        workspace.id,
      ),
    };
  }

  @Post("workspaces")
  @RequireDashboardRole("admin")
  @ApiOperation({ summary: "Create a local OSS workspace" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        name: { type: "string", example: "Production Agents" },
        slug: { type: "string", example: "production-agents" },
      },
      required: ["name"],
    },
  })
  @ApiOkResponse({ type: WorkspaceMutationResponseDto })
  async createWorkspace(
    @Req()
    req: Request & {
      dashboardUserId?: string;
    },
    @Body() body: { name?: string; slug?: string },
  ) {
    const created = await this.workspaces.withTransaction(async (workspaces, manager) => {
      const item = await workspaces.createWorkspace({ name: body?.name || "", slug: body?.slug });
      await this.workspaceMemberships().withTransaction((memberships) => memberships.ensureMembership({
        userId: req.dashboardUserId || "dashboard",
        organizationId: item.organization_id,
        workspaceId: item.id,
        role: "admin",
      }), manager);
      await this.recordWorkspaceMutationAudit({ action: "workspace.create", actorId: req.dashboardUserId || "dashboard", workspace: item, afterSummary: item }, manager);
      return item;
    });
    return {
      success: true,
      message: "Workspace created",
      item: created,
      state: await this.workspaceStateForDashboard(
        req.dashboardUserId || "dashboard",
        "admin",
        created.id,
      ),
    };
  }

  @Put("workspaces/:id")
  @RequireDashboardRole("admin")
  @ApiOperation({ summary: "Rename a local OSS workspace" })
  @ApiParam({ name: "id", example: "default-workspace" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        name: { type: "string", example: "Production Agents" },
        slug: { type: "string", example: "production-agents" },
      },
    },
  })
  @ApiOkResponse({ type: WorkspaceMutationResponseDto })
  async renameWorkspace(
    @Req()
    req: Request & {
      dashboardUserId?: string;
    },
    @Param("id") id: string,
    @Body() body: { name?: string; slug?: string },
  ) {
    const updated = await this.workspaces.withTransaction(async (workspaces, manager) => {
      await workspaces.lockWorkspace(id);
      return this.workspaceMemberships().withTransaction(async (memberships) => {
        const existing = await this.requireWorkspaceAdminTarget(id, req.dashboardUserId || "dashboard", false, workspaces, memberships);
        const item = await workspaces.renameWorkspace(id, body || {});
        await this.recordWorkspaceMutationAudit({ action: "workspace.rename", actorId: req.dashboardUserId || "dashboard", workspace: item, beforeSummary: existing, afterSummary: item }, manager);
        return item;
      }, manager);
    });
    return {
      success: true,
      message: "Workspace updated",
      item: updated,
      state: await this.workspaceStateForDashboard(
        req.dashboardUserId || "dashboard",
        "admin",
        updated.id,
      ),
    };
  }

  @Post("workspaces/:id/disable")
  @RequireDashboardRole("admin")
  @ApiOperation({ summary: "Disable a local OSS workspace" })
  @ApiParam({ name: "id", example: "ws_6f4a..." })
  @ApiOkResponse({ type: WorkspaceMutationResponseDto })
  async disableWorkspace(
    @Req()
    req: Request & {
      dashboardUserId?: string;
    },
    @Param("id") id: string,
  ) {
    const updated = await this.workspaces.withTransaction(async (workspaces, manager) => {
      await workspaces.lockWorkspace(id);
      return this.workspaceMemberships().withTransaction(async (memberships) => {
        const existing = await this.requireWorkspaceAdminTarget(id, req.dashboardUserId || "dashboard", false, workspaces, memberships);
        const item = await workspaces.setWorkspaceStatus(id, "disabled");
        await this.recordWorkspaceMutationAudit({ action: "workspace.disable", actorId: req.dashboardUserId || "dashboard", workspace: item, beforeSummary: existing, afterSummary: item }, manager);
        return item;
      }, manager);
    });
    return {
      success: true,
      message: "Workspace disabled",
      item: updated,
      state: await this.workspaceStateForDashboard(
        req.dashboardUserId || "dashboard",
        "admin",
        undefined,
      ),
    };
  }

  @Post("workspaces/:id/reactivate")
  @RequireDashboardRole("admin")
  @ApiOperation({ summary: "Reactivate a local OSS workspace" })
  @ApiParam({ name: "id", example: "ws_6f4a..." })
  @ApiOkResponse({ type: WorkspaceMutationResponseDto })
  async reactivateWorkspace(
    @Req()
    req: Request & {
      dashboardUserId?: string;
    },
    @Param("id") id: string,
  ) {
    const updated = await this.workspaces.withTransaction(async (workspaces, manager) => {
      await workspaces.lockWorkspace(id);
      return this.workspaceMemberships().withTransaction(async (memberships) => {
        const existing = await this.requireWorkspaceAdminTarget(id, req.dashboardUserId || "dashboard", true, workspaces, memberships);
        const item = await workspaces.setWorkspaceStatus(id, "active");
        await this.recordWorkspaceMutationAudit({ action: "workspace.reactivate", actorId: req.dashboardUserId || "dashboard", workspace: item, beforeSummary: existing, afterSummary: item }, manager);
        return item;
      }, manager);
    });
    return {
      success: true,
      message: "Workspace reactivated",
      item: updated,
      state: await this.workspaceStateForDashboard(
        req.dashboardUserId || "dashboard",
        "admin",
        updated.id,
      ),
    };
  }

  private dashboardPermissions(role: WorkspaceMembershipRole): {
    can_read: boolean;
    can_operate: boolean;
    can_admin: boolean;
  } {
    return {
      can_read: true,
      can_operate: role === "operator" || role === "admin",
      can_admin: role === "admin",
    };
  }

  private async workspaceStateForDashboard(
    userId: string,
    role: WorkspaceMembershipRole,
    activeWorkspaceId?: string | null,
  ) {
    const accessibleWorkspaceIds =
      await this.accessibleWorkspaceIdsForUser(userId);
    const state = await this.workspaces.getState(activeWorkspaceId, {
      includeDisabled: role === "admin",
      workspaceIds: accessibleWorkspaceIds,
    });
    const actualRole =
      (await this.workspaceMemberships().findActiveRole(
        userId,
        state.active_workspace.id,
      )) || role;
    return {
      ...state,
      access: {
        user_id: userId,
        role: actualRole,
        permissions: this.dashboardPermissions(actualRole),
      },
    };
  }

  private async accessibleWorkspaceIdsForUser(
    userId: string,
  ): Promise<string[]> {
    const memberships = await this.workspaceMemberships().listForUser(userId);
    return memberships
      .filter(
        (membership) =>
          membership.user_id === userId && membership.status === "active",
      )
      .map((membership) => membership.workspace_id);
  }

  private async requireWorkspaceAdminTarget(
    id: string,
    userId: string,
    allowDisabled = false,
    workspaces = this.workspaces,
    memberships = this.workspaceMemberships(),
  ) {
    const state = await workspaces.getState(id, { includeDisabled: true });
    const workspace = state.workspaces.find((item) => item.id === id);
    if (!workspace) {
      throw new HttpException(
        { success: false, message: `Workspace not found: ${id}` },
        HttpStatus.NOT_FOUND,
      );
    }
    const role =
      workspace.status === "disabled" && allowDisabled
        ? (await memberships.listForUser(userId)).find(
            (membership) =>
              membership.workspace_id === workspace.id &&
              membership.role === "admin" &&
              membership.status === "active",
          )?.role || null
        : await memberships.findActiveRole(
            userId,
            workspace.id,
          );
    if (role !== "admin") {
      throw new HttpException(
        {
          error: {
            message: "Requires admin role for this workspace.",
            type: "dashboard_permission_denied",
            code: "workspace_role_required",
          },
          required_role: "admin",
          current_role: role,
          workspace_id: workspace.id,
        },
        HttpStatus.FORBIDDEN,
      );
    }
    return workspace;
  }

  private async recordWorkspaceMutationAudit(input: {
    action: string;
    actorId: string;
    workspace: {
      id: string;
      organization_id: string;
      name: string;
      slug: string;
      status: string;
      is_default: boolean;
    };
    beforeSummary?: unknown;
    afterSummary?: unknown;
  }, manager?: EntityManager) {
    await this.managementAudit.record({
      action: input.action,
      resourceType: "workspace",
      resourceId: input.workspace.id,
      organizationId: input.workspace.organization_id,
      workspaceId: input.workspace.id,
      actor: { type: "dashboard", id: input.actorId },
      beforeSummary: input.beforeSummary,
      afterSummary: input.afterSummary,
      metadata: {
        workspace_id: input.workspace.id,
        slug: input.workspace.slug,
        status: input.workspace.status,
        is_default: input.workspace.is_default,
      },
    }, manager);
  }

  @Get("members")
  @RequireDashboardRole("admin")
  @ApiTags("Workspace Members")
  @ApiOperation({ summary: "List workspace members and roles" })
  @ApiOkResponse({ type: WorkspaceMemberListResponseDto })
  async getWorkspaceMembers() {
    return {
      items: await this.workspaceMemberships().list(
        this.workspaceContext.currentWorkspaceId(),
      ),
      roles: ["admin", "operator", "viewer"],
      mode: this.config.dashboardOidc.enabled
        ? "local_dashboard_oidc"
        : "local_dashboard",
    };
  }

  @Put("members/:id")
  @RequireDashboardRole("admin")
  @ApiTags("Workspace Members")
  @ApiOperation({ summary: "Update a workspace member role or status" })
  @ApiParam({ name: "id", example: "membership-default-dashboard-admin" })
  @ApiOkResponse({ type: WorkspaceMemberMutationResponseDto })
  async updateWorkspaceMember(
    @Param("id") id: string,
    @Body()
    body: {
      role?: WorkspaceMembershipRole;
      status?: WorkspaceMembershipStatus;
    },
  ) {
    const workspaceId = this.workspaceContext.currentWorkspaceId();
    const updated = await this.workspaceMemberships().withTransaction(async (memberships, manager) => {
      await memberships.lockWorkspace(workspaceId);
      const before = (await memberships.list(workspaceId)).find((member) => member.id === id);
      const item = await memberships.update(id, body || {}, workspaceId);
      await this.configAudit.recordManagementEvent({
        action: "workspace_member.update",
        target: `workspace_member:${id}`,
        beforeSummary: before ? { ...before } : null,
        afterSummary: { user_id: item.user_id, role: item.role, status: item.status, workspace_id: item.workspace_id },
      }, manager);
      return item;
    });
    return {
      success: true,
      message: "Workspace member updated",
      item: updated,
    };
  }

  @Get("members/invitations")
  @RequireDashboardRole("admin")
  @ApiTags("Workspace Members")
  @ApiOperation({ summary: "List workspace invitations" })
  @ApiOkResponse({ type: WorkspaceInvitationListResponseDto })
  async getWorkspaceInvitations() {
    return {
      items: await this.workspaceInvitations().list(
        this.workspaceContext.currentWorkspaceId(),
      ),
    };
  }

  @Post("members/invitations")
  @RequireDashboardRole("admin")
  @ApiTags("Workspace Members")
  @ApiOperation({ summary: "Create workspace invitation metadata" })
  @ApiOkResponse({ type: WorkspaceInvitationMutationResponseDto })
  async createWorkspaceInvitation(
    @Req()
    req: Request & {
      dashboardUserId?: string;
    },
    @Body()
    body: {
      email?: string;
      role?: WorkspaceMembershipRole;
      expires_in_hours?: number;
    },
  ) {
    const created = await this.workspaces.withTransaction(async (workspaces, manager) => {
      const workspaceId = this.workspaceContext.currentWorkspaceId();
      await workspaces.lockWorkspace(workspaceId);
      const workspace = await workspaces.requireWorkspace(workspaceId);
      const item = await this.workspaceInvitations().withTransaction((invitations) => invitations.create({
        organizationId: workspace.organization_id,
        workspaceId: workspace.id,
        role: body?.role || "viewer",
        email: body?.email,
        expiresInHours: body?.expires_in_hours,
        createdByUserId: req.dashboardUserId || "dashboard",
      }), manager);
      await this.configAudit.recordManagementEvent({
        action: "workspace_invitation.create",
        target: `workspace_invitation:${item.id}`,
        actor: { type: "dashboard", id: req.dashboardUserId || "dashboard" },
        afterSummary: { role: item.role, status: item.status, workspace_id: item.workspace_id, email: item.email ? "[set]" : null, expires_at: item.expires_at },
      }, manager);
      return item;
    });
    return {
      success: true,
      message: "Workspace invitation created",
      item: created,
    };
  }

  @Delete("members/invitations/:id")
  @RequireDashboardRole("admin")
  @ApiTags("Workspace Members")
  @ApiOperation({ summary: "Revoke a pending workspace invitation" })
  @ApiOkResponse({ type: WorkspaceInvitationMutationResponseDto })
  async revokeWorkspaceInvitation(
    @Req()
    req: Request & {
      dashboardUserId?: string;
    },
    @Param("id") id: string,
  ) {
    const revoked = await this.workspaceInvitations().withTransaction(async (invitations, manager) => {
      const item = await invitations.revoke(id, this.workspaceContext.currentWorkspaceId());
      await this.configAudit.recordManagementEvent({
        action: "workspace_invitation.revoke",
        target: `workspace_invitation:${id}`,
        actor: { type: "dashboard", id: req.dashboardUserId || "dashboard" },
        afterSummary: { role: item.role, status: item.status, workspace_id: item.workspace_id },
      }, manager);
      return item;
    });
    return {
      success: true,
      message: "Workspace invitation revoked",
      item: revoked,
    };
  }

  private workspaceMemberships(): WorkspaceMembershipService {
    if (!this.memberships) {
      throw new HttpException(
        { success: false, message: "Workspace membership service unavailable" },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.memberships;
  }

  private workspaceInvitations(): WorkspaceInvitationService {
    if (!this.invitations) {
      throw new HttpException(
        { success: false, message: "Workspace invitation service unavailable" },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.invitations;
  }

  @Get("cluster")
  @RequireDashboardRole("viewer")
  @ApiOperation({
    summary: "Get privacy-safe local cluster and shared state status",
  })
  @ApiOkResponse({
    description:
      "Local node id, shared state backend, Redis connectivity, recent state errors, and instance inventory without secrets or request payloads.",
  })
  async getClusterStatus() {
    return this.cluster.getDashboardStatus();
  }

  /** Delete logs older than log_retention_days (default: 30) */
  private async cleanupOldLogs(): Promise<void> {
    const retentionDays = this.config.database.log_retention_days ?? 30;
    if (retentionDays <= 0) return;

    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    let deletedCallLogs = 0;
    let deletedRouteDecisions = 0;

    while (!this.cleanupStopped) {
      const batch = await withCoordinatedRepository(
        this.callLogRepo,
        true,
        async (repo) => {
          const rows = await repo
            .createQueryBuilder("log")
            .select("log.id", "id")
            .where("log.timestamp < :cutoff", { cutoff })
            .orderBy("log.timestamp", "ASC")
            .take(500)
            .getRawMany<{ id: number }>();
          if (rows.length === 0) return { found: false, deleted: 0 };
          const result = await repo.delete(rows.map((row) => Number(row.id)));
          return { found: true, deleted: result.affected || 0 };
        },
      );
      if (!batch.found) break;
      deletedCallLogs += batch.deleted;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    while (!this.cleanupStopped) {
      const batch = await withCoordinatedRepository(
        this.routeDecisionRepo,
        true,
        async (repo) => {
          const rows = await repo
            .createQueryBuilder("decision")
            .select("decision.id", "id")
            .where("decision.timestamp < :cutoff", { cutoff })
            .orderBy("decision.timestamp", "ASC")
            .take(500)
            .getRawMany<{ id: number }>();
          if (rows.length === 0) return { found: false, deleted: 0 };
          const result = await repo.delete(rows.map((row) => Number(row.id)));
          return { found: true, deleted: result.affected || 0 };
        },
      );
      if (!batch.found) break;
      deletedRouteDecisions += batch.deleted;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    if (deletedCallLogs > 0 || deletedRouteDecisions > 0) {
      this.logger.log(
        `Log cleanup: deleted ${deletedCallLogs} call logs and ${deletedRouteDecisions} route decisions older than ${retentionDays} days`,
      );
    }
  }

  // ══════════════════════════════════════════════════════
  // MCP Gateway
  // ══════════════════════════════════════════════════════

  @Get("mcp")
  @ApiOperation({ summary: "Get metadata-only MCP Gateway preview status" })
  @ApiOkResponse({
    description:
      "MCP server registry, tools, recent calls, and error summary without tool input/output, raw headers, provider keys, or secret values.",
  })
  getMcpGateway() {
    return (
      this.mcp?.getDashboardSummary() || {
        enabled: false,
        path: "/mcp",
        metadata_only: true,
        servers: [],
        recent_calls: [],
        error_summary: [],
        denial_summary: [],
        totals: {
          servers: 0,
          enabled_servers: 0,
          tools: 0,
          recent_calls: 0,
          recent_errors: 0,
        },
      }
    );
  }

  @Get("agent-platform")
  @RequireDashboardRole("viewer")
  @ApiTags("Agent Platform")
  @ApiOperation({
    summary: "Get metadata-only Agent Platform preview status",
  })
  @ApiOkResponse({ type: AgentPlatformResponseDto })
  async getAgentPlatform() {
    return this.agentPlatform.getDashboardSummary();
  }

  // ══════════════════════════════════════════════════════
  // Guardrails
  // ══════════════════════════════════════════════════════

  @Get("guardrails")
  @ApiOperation({
    summary: "Get privacy-safe guardrails plugin summary and webhook status",
  })
  @ApiOkResponse({
    description:
      "Guardrails finding counters and webhook delivery status without prompts, responses, raw headers, provider keys, webhook URLs, or webhook headers.",
  })
  getGuardrailsStatus() {
    const status = this.plugins?.getPluginStatus("guardrails");
    return (
      status || {
        enabled: false,
        mode: "audit",
        rules: {
          total: 0,
          by_kind: {},
          by_action: {},
          schema: {
            input_enabled: false,
            output_enabled: false,
            input_strict: false,
            output_strict: false,
          },
        },
        findings: {
          total: 0,
          by_kind: {},
          by_action: {},
          last_seen_at: null,
          recent: [],
        },
        webhook: {
          enabled: false,
          configured: false,
          queue_depth: 0,
          max_queue: 0,
          drop_policy: "drop_newest",
          dropped: 0,
          last_status: null,
          last_error: null,
          last_sent_at: null,
          recent: [],
        },
        privacy: {
          prompt: false,
          response: false,
          raw_headers: false,
          provider_keys: false,
          media_bytes: false,
        },
      }
    );
  }

  // ══════════════════════════════════════════════════════
  // Benchmark Report
  // ══════════════════════════════════════════════════════

  @Get("benchmarks/report")
  @ApiOperation({
    summary: "Get local benchmark report from sanitized call-log metadata",
  })
  @ApiQuery({ name: "period", required: false, example: "24h" })
  @ApiQuery({ name: "namespace", required: false })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "node", required: false })
  @ApiQuery({ name: "model", required: false })
  @ApiQuery({ name: "source_format", required: false })
  @ApiQuery({ name: "limit", required: false, example: 5000 })
  @ApiOkResponse({
    description:
      "Read-only benchmark summary with latency percentiles, throughput estimate, cost/tokens, status distribution, node:model and source-format breakdowns.",
  })
  async getBenchmarkReport(
    @Query("period") period: string = "24h",
    @Query("namespace") namespaceId?: string,
    @Query("api_key") apiKey?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("node") node?: string,
    @Query("model") model?: string,
    @Query("source_format") sourceFormat?: string,
    @Query("limit") limit?: string,
  ) {
    const service =
      this.benchmarkReports ||
      new BenchmarkReportService(
        this.callLogRepo,
        this.routeDecisionRepo,
        this.catalog,
      );
    return service.getReport({
      period,
      namespace: namespaceId,
      api_key: apiKey,
      api_key_id: apiKeyId,
      node,
      model,
      source_format: sourceFormat,
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ══════════════════════════════════════════════════════
  // Batch Jobs
  // ══════════════════════════════════════════════════════

  @Get("batches")
  @ApiOperation({
    summary: "List privacy-safe Batch API job metadata for the Dashboard",
  })
  @ApiQuery({ name: "period", required: false, example: "24h" })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "node", required: false })
  @ApiQuery({ name: "namespace", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "limit", required: false, example: 100 })
  @ApiOkResponse({
    description:
      "Batch job metadata only. Input/output file contents, prompts, raw headers, and provider keys are never returned.",
  })
  async getBatchJobs(
    @Query("period") period: string = "24h",
    @Query("status") status?: string,
    @Query("node") node?: string,
    @Query("namespace") namespace?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("limit") limit?: string,
  ) {
    return this.batchJobs.dashboardSummary({
      period,
      status,
      node,
      namespace,
      api_key_id: apiKeyId,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /** Return a SQL expression that truncates a timestamp column to YYYY-MM-DD string */
  private dateTruncDay(column: string): string {
    if (this.dataSource.options.type === "postgres") {
      return `TO_CHAR(${column}, 'YYYY-MM-DD')`;
    }
    return `strftime('%Y-%m-%d', ${column})`;
  }

  private logWhere(
    apiKey?: string,
    apiKeyId?: string,
    namespaceId?: string,
  ): FindOptionsWhere<CallLog> {
    const where: FindOptionsWhere<CallLog> = workspaceFindWhereStrict(
      this.workspaceContext.currentWorkspaceId(),
      {},
    );
    if (apiKeyId) where.api_key_id = apiKeyId;
    else if (apiKey) where.api_key_name = apiKey;
    if (namespaceId) where.namespace_id = namespaceId;
    return where;
  }

  private applyLogScopeFilter<
    T extends { where: Function; andWhere: Function },
  >(
    qb: T,
    apiKey?: string,
    apiKeyId?: string,
    namespaceId?: string,
    method: "where" | "andWhere" = "andWhere",
  ): T {
    applyWorkspaceQueryScope(
      qb,
      "log",
      this.workspaceContext.currentWorkspaceId(),
      method,
    );
    let currentMethod: "where" | "andWhere" = "andWhere";
    if (apiKeyId) {
      qb[currentMethod]("log.api_key_id = :apiKeyId", { apiKeyId });
      currentMethod = "andWhere";
    } else if (apiKey) {
      qb[currentMethod]("log.api_key_name = :apiKey", { apiKey });
      currentMethod = "andWhere";
    }
    if (namespaceId) {
      qb[currentMethod]("log.namespace_id = :namespaceId", { namespaceId });
    }
    return qb;
  }

  private applyRouteDecisionScopeFilter<
    T extends { where: Function; andWhere: Function },
  >(
    qb: T,
    apiKey?: string,
    apiKeyId?: string,
    namespaceId?: string,
    method: "where" | "andWhere" = "andWhere",
  ): T {
    applyWorkspaceQueryScope(
      qb,
      "decision",
      this.workspaceContext.currentWorkspaceId(),
      method,
    );
    let currentMethod: "where" | "andWhere" = "andWhere";
    if (apiKeyId) {
      qb[currentMethod]("decision.api_key_id = :apiKeyId", { apiKeyId });
      currentMethod = "andWhere";
    } else if (apiKey) {
      qb[currentMethod]("decision.api_key_name = :apiKey", { apiKey });
      currentMethod = "andWhere";
    }
    if (namespaceId) {
      qb[currentMethod]("decision.namespace_id = :namespaceId", {
        namespaceId,
      });
    }
    return qb;
  }

  private serializeRouteDecision(
    decision: RouteDecisionLog,
    includeTrace: boolean,
  ) {
    const trace = includeTrace
      ? this.parseRouteDecisionTrace(decision.trace_json)
      : null;
    const finalSelection = trace?.final_selection || {
      node: decision.selected_node_id,
      model: decision.selected_model,
      reason:
        decision.fallback_reason ||
        decision.strategy ||
        decision.route_mode ||
        null,
      is_fallback: decision.is_fallback,
      fallback_reason: decision.fallback_reason,
    };

    return {
      id: decision.id,
      request_id: decision.request_id,
      timestamp: decision.timestamp,
      source_format: decision.source_format,
      tier: decision.tier,
      score: decision.score,
      route_mode: decision.route_mode,
      strategy: decision.strategy,
      selected: {
        node: decision.selected_node_id,
        model: decision.selected_model,
      },
      final_selection: finalSelection,
      domain_hint: decision.domain_hint,
      candidate_count: decision.candidate_count,
      filtered_count: decision.filtered_count,
      status_code: decision.status_code,
      is_fallback: decision.is_fallback,
      fallback_reason: decision.fallback_reason,
      session_id: decision.session_id || trace?.session_id || null,
      trace_id: decision.trace_id || trace?.trace_id || null,
      api_key_name: decision.api_key_name,
      api_key_id: decision.api_key_id,
      namespace_id: decision.namespace_id,
      agent: {
        connector: decision.agent_connector || trace?.agent?.connector || null,
        profile_id:
          decision.agent_profile_id || trace?.agent?.profile_id || null,
        profile_name:
          decision.agent_profile_name || trace?.agent?.profile_name || null,
        virtual_model:
          decision.agent_virtual_model || trace?.agent?.virtual_model || null,
        requested_model:
          decision.agent_requested_model ||
          trace?.agent?.requested_model ||
          null,
        session_id:
          decision.agent_session_id || trace?.agent?.session_id || null,
        turn_id: decision.agent_turn_id || trace?.agent?.turn_id || null,
        repo: decision.agent_repo || trace?.agent?.repo || null,
        project: decision.agent_project || trace?.agent?.project || null,
      },
      summary: {
        reason: finalSelection.reason,
        fallback_chain: trace?.fallback_chain || [],
        filters: trace?.filters || [],
        intelligence: trace?.intelligence || null,
        compatibility:
          trace?.candidate_targets.find((candidate) => candidate.selected)
            ?.compatibility_evidence || null,
        privacy: trace?.privacy || {
          prompt: false,
          response: false,
          raw_headers: false,
          provider_keys: false,
        },
      },
      ...(includeTrace ? { trace } : {}),
    };
  }

  private parseRouteDecisionTrace(value: string): RouteDecisionTrace | null {
    try {
      return JSON.parse(value) as RouteDecisionTrace;
    } catch {
      return null;
    }
  }

  private sessionWindow(
    period: string | undefined,
    fallback: string,
  ): { period: string; since: Date | null } {
    const selected = (period || fallback).trim().toLowerCase();
    if (selected === "all") {
      return { period: "all", since: null };
    }
    const match = selected.match(/^(\d+)(h|d)$/);
    if (!match) {
      return this.sessionWindow(fallback, fallback);
    }
    const amount = Math.max(
      1,
      Math.min(Number(match[1]), match[2] === "h" ? 24 * 90 : 365),
    );
    const millis = match[2] === "h" ? amount * 3_600_000 : amount * 86_400_000;
    return {
      period: `${amount}${match[2]}`,
      since: new Date(Date.now() - millis),
    };
  }

  private groupLogsBySession(logs: CallLog[]): Map<string, CallLog[]> {
    const grouped = new Map<string, CallLog[]>();
    for (const log of logs) {
      const sessionId =
        log.agent_session_id || log.session_id || log.session_key;
      if (!sessionId) continue;
      const rows = grouped.get(sessionId) || [];
      rows.push(log);
      grouped.set(sessionId, rows);
    }
    return grouped;
  }

  private buildSessionSummary(sessionId: string, logs: CallLog[]) {
    const sorted = [...logs].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const models = this.uniqueSorted(
      sorted.map((log) => log.model).filter(Boolean),
    );
    const nodes = this.uniqueSorted(
      sorted.map((log) => log.node_id).filter(Boolean),
    );
    const sourceFormats = this.uniqueSorted(
      sorted.map((log) => log.source_format).filter(Boolean),
    );
    const traceIds = this.uniqueSorted(
      sorted
        .map((log) => log.trace_id)
        .filter((value): value is string => Boolean(value)),
    );
    const agentConnectors = this.uniqueSorted(
      sorted
        .map((log) => log.agent_connector)
        .filter((value): value is string => Boolean(value)),
    );
    const agentProfiles = this.uniqueSorted(
      sorted
        .map((log) => log.agent_profile_name || log.agent_profile_id)
        .filter((value): value is string => Boolean(value)),
    );
    const agentRepos = this.uniqueSorted(
      sorted
        .map((log) => log.agent_repo)
        .filter((value): value is string => Boolean(value)),
    );
    const agentProjects = this.uniqueSorted(
      sorted
        .map((log) => log.agent_project)
        .filter((value): value is string => Boolean(value)),
    );
    const errorCount = sorted.filter(
      (log) => log.status_code >= 400 || log.error,
    ).length;
    const fallbackCount = sorted.filter(
      (log) => log.is_fallback || Boolean(log.fallback_reason),
    ).length;
    const totalCost = sorted.reduce((sum, log) => sum + (log.cost_usd || 0), 0);
    const totalTokens = sorted.reduce(
      (sum, log) => sum + (log.input_tokens || 0) + (log.output_tokens || 0),
      0,
    );
    const avgLatency =
      sorted.length > 0
        ? sorted.reduce((sum, log) => sum + (log.latency_ms || 0), 0) /
          sorted.length
        : 0;

    return {
      session_id: sessionId,
      first_seen_at: first?.timestamp || null,
      last_seen_at: last?.timestamp || null,
      request_count: sorted.length,
      error_count: errorCount,
      fallback_count: fallbackCount,
      model_switch_count: this.countModelSwitches(sorted),
      total_cost_usd: Number(totalCost.toFixed(6)),
      total_tokens: totalTokens,
      avg_latency_ms: Math.round(avgLatency),
      models,
      nodes,
      source_formats: sourceFormats,
      trace_ids: traceIds,
      latest_request_id: last?.request_id || null,
      latest_trace_id: last?.trace_id || null,
      latest_status_code: last?.status_code || null,
      api_key_id: last?.api_key_id || null,
      api_key_name: last?.api_key_name || null,
      namespace_id: last?.namespace_id || null,
      agent: {
        connector: last?.agent_connector || null,
        connectors: agentConnectors,
        profile_id: last?.agent_profile_id || null,
        profile_name: last?.agent_profile_name || null,
        profiles: agentProfiles,
        virtual_model: last?.agent_virtual_model || null,
        requested_model: last?.agent_requested_model || null,
        session_id: last?.agent_session_id || null,
        turn_id: last?.agent_turn_id || null,
        repo: last?.agent_repo || null,
        repos: agentRepos,
        project: last?.agent_project || null,
        projects: agentProjects,
      },
    };
  }

  private serializeSessionTimelineEvent(
    log: CallLog,
    decision: RouteDecisionLog | null,
    shadowRows: ShadowTrafficResult[],
    guardrails: {
      count: number;
      kinds: string[];
      actions: string[];
      rules: string[];
    } | null,
  ) {
    const trace = decision
      ? this.parseRouteDecisionTrace(decision.trace_json)
      : null;
    const shadowStatuses = shadowRows.reduce<Record<string, number>>(
      (acc, row) => {
        acc[row.status] = (acc[row.status] || 0) + 1;
        return acc;
      },
      {},
    );
    const shadowLatency = shadowRows
      .map((row) => row.latency_ms)
      .filter((value): value is number => typeof value === "number");

    return {
      request_id: log.request_id,
      session_id:
        log.agent_session_id || log.session_id || log.session_key || null,
      trace_id: log.trace_id || decision?.trace_id || trace?.trace_id || null,
      timestamp: log.timestamp,
      source_format: log.source_format,
      tier: log.tier,
      score: log.score,
      node_id: log.node_id,
      model: log.model,
      status_code: log.status_code,
      latency_ms: log.latency_ms,
      stream: Boolean(log.stream),
      cost_usd: Number((log.cost_usd || 0).toFixed(6)),
      input_tokens: log.input_tokens,
      output_tokens: log.output_tokens,
      total_tokens: (log.input_tokens || 0) + (log.output_tokens || 0),
      is_fallback: log.is_fallback,
      fallback_reason: log.fallback_reason,
      error: log.error,
      route_decision_link: decision
        ? `/route-decisions/${encodeURIComponent(log.request_id)}`
        : null,
      has_route_decision: Boolean(decision),
      agent: {
        connector: log.agent_connector || trace?.agent?.connector || null,
        profile_id: log.agent_profile_id || trace?.agent?.profile_id || null,
        profile_name:
          log.agent_profile_name || trace?.agent?.profile_name || null,
        virtual_model:
          log.agent_virtual_model || trace?.agent?.virtual_model || null,
        requested_model:
          log.agent_requested_model || trace?.agent?.requested_model || null,
        session_id: log.agent_session_id || trace?.agent?.session_id || null,
        turn_id: log.agent_turn_id || trace?.agent?.turn_id || null,
        repo: log.agent_repo || trace?.agent?.repo || null,
        project: log.agent_project || trace?.agent?.project || null,
      },
      route_decision: decision
        ? {
            id: decision.id,
            selected_node_id: decision.selected_node_id,
            selected_model: decision.selected_model,
            candidate_count: decision.candidate_count,
            filtered_count: decision.filtered_count,
            route_mode: decision.route_mode,
            strategy: decision.strategy,
            final_reason: trace?.final_selection?.reason || null,
          }
        : null,
      shadow: {
        count: shadowRows.length,
        statuses: shadowStatuses,
        nodes: this.uniqueSorted(shadowRows.map((row) => row.shadow_node)),
        models: this.uniqueSorted(shadowRows.map((row) => row.shadow_model)),
        avg_latency_ms:
          shadowLatency.length > 0
            ? Math.round(
                shadowLatency.reduce((sum, value) => sum + value, 0) /
                  shadowLatency.length,
              )
            : null,
      },
      guardrails: guardrails || {
        count: 0,
        kinds: [],
        actions: [],
        rules: [],
      },
    };
  }

  private guardrailsFindingsByRequest(): Map<
    string,
    { count: number; kinds: string[]; actions: string[]; rules: string[] }
  > {
    const status = this.plugins?.getPluginStatus("guardrails") as
      | { findings?: { recent?: unknown[] } }
      | undefined;
    const recent = Array.isArray(status?.findings?.recent)
      ? status.findings.recent
      : [];
    const grouped = new Map<
      string,
      {
        count: number;
        kinds: Set<string>;
        actions: Set<string>;
        rules: Set<string>;
      }
    >();
    for (const item of recent) {
      if (!item || typeof item !== "object") continue;
      const finding = item as Record<string, unknown>;
      const requestId =
        typeof finding.request_id === "string" ? finding.request_id : null;
      if (!requestId) continue;
      const bucket = grouped.get(requestId) || {
        count: 0,
        kinds: new Set<string>(),
        actions: new Set<string>(),
        rules: new Set<string>(),
      };
      bucket.count += 1;
      if (typeof finding.kind === "string") bucket.kinds.add(finding.kind);
      if (typeof finding.action === "string")
        bucket.actions.add(finding.action);
      if (typeof finding.rule === "string") bucket.rules.add(finding.rule);
      grouped.set(requestId, bucket);
    }

    return new Map(
      [...grouped.entries()].map(([requestId, bucket]) => [
        requestId,
        {
          count: bucket.count,
          kinds: this.uniqueSorted([...bucket.kinds]),
          actions: this.uniqueSorted([...bucket.actions]),
          rules: this.uniqueSorted([...bucket.rules]),
        },
      ]),
    );
  }

  private countModelSwitches(logs: CallLog[]): number {
    let switches = 0;
    let previous: string | null = null;
    for (const log of logs) {
      if (previous && log.model && log.model !== previous) switches += 1;
      if (log.model) previous = log.model;
    }
    return switches;
  }

  private uniqueSorted(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    );
  }

  private sessionPrivacySummary() {
    return {
      prompt: false,
      response: false,
      raw_headers: false,
      provider_keys: false,
      media_bytes: false,
      video_bytes: false,
      source_code: false,
      diffs: false,
      tool_payloads: false,
      storage: "metadata_only",
    };
  }

  @Get("intelligence/summary")
  @ApiOperation({
    summary: "Get metadata-only cost optimizer and quality gate summary",
  })
  @ApiQuery({ name: "period", required: false, example: "7d" })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "namespace", required: false })
  @ApiOkResponse({
    description:
      "Intelligence loop summary from call-log metadata; no prompts, responses, raw headers, provider keys, or tool payloads.",
  })
  async getIntelligenceSummary(
    @Query("period") period: string = "7d",
    @Query("api_key") apiKey?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("namespace") namespaceId?: string,
  ) {
    const periodDays =
      period === "90d" ? 90 : period === "30d" ? 30 : period === "1d" ? 1 : 7;
    const since = new Date(Date.now() - periodDays * 86_400_000);
    const where = this.logWhere(apiKey, apiKeyId, namespaceId);
    where.timestamp = MoreThanOrEqual(since);
    const logs = await this.callLogRepo.find({
      where,
      select: {
        node_id: true,
        model: true,
        agent_virtual_model: true,
        agent_connector: true,
        intelligence_optimizer_applied: true,
        intelligence_estimated_savings_usd: true,
        async_eval_queued: true,
        token_prediction_risk: true,
        quality_gate_status: true,
      },
      order: { timestamp: "DESC" },
      take: 5000,
    });

    const optimizerApplied = logs.filter((log) =>
      Boolean(
        (log as CallLog & { intelligence_optimizer_applied?: boolean })
          .intelligence_optimizer_applied,
      ),
    );
    const estimatedSavings = logs.reduce(
      (sum, log) =>
        sum +
        Number(
          (
            log as CallLog & {
              intelligence_estimated_savings_usd?: number | null;
            }
          ).intelligence_estimated_savings_usd || 0,
        ),
      0,
    );
    const asyncQueued = logs.filter((log) =>
      Boolean(
        (log as CallLog & { async_eval_queued?: boolean }).async_eval_queued,
      ),
    ).length;
    const tokenRisk = this.countBy(
      logs.map((log) =>
        String(
          (log as CallLog & { token_prediction_risk?: string | null })
            .token_prediction_risk || "unknown",
        ),
      ),
    );
    const qualityGate = this.countBy(
      logs.map((log) =>
        String(
          (log as CallLog & { quality_gate_status?: string | null })
            .quality_gate_status || "skipped",
        ),
      ),
    );
    const byAgent = this.groupIntelligenceRows(
      logs,
      (log) => log.agent_virtual_model || log.agent_connector || "non_agent",
    );
    const byNode = this.groupIntelligenceRows(
      logs,
      (log) => `${log.node_id || "unknown"}:${log.model || "unknown"}`,
    );

    return {
      period,
      generated_at: new Date().toISOString(),
      summary: {
        total_requests: logs.length,
        optimizer_applied: optimizerApplied.length,
        optimizer_applied_rate:
          logs.length > 0
            ? Number((optimizerApplied.length / logs.length).toFixed(4))
            : 0,
        estimated_savings_usd: Number(estimatedSavings.toFixed(6)),
        async_eval_queued: asyncQueued,
        token_risk: tokenRisk,
        quality_gate: qualityGate,
        privacy: {
          prompt: false,
          response: false,
          raw_headers: false,
          provider_keys: false,
          tool_payloads: false,
          storage: "metadata_only",
        },
      },
      by_agent: byAgent,
      by_node: byNode,
    };
  }

  private groupIntelligenceRows(
    logs: CallLog[],
    keyFn: (log: CallLog) => string,
  ) {
    const groups = new Map<
      string,
      {
        key: string;
        requests: number;
        optimizer_applied: number;
        estimated_savings_usd: number;
        async_eval_queued: number;
        quality_gate_failed: number;
        near_or_over_budget: number;
      }
    >();
    for (const log of logs) {
      const key = keyFn(log);
      const group = groups.get(key) || {
        key,
        requests: 0,
        optimizer_applied: 0,
        estimated_savings_usd: 0,
        async_eval_queued: 0,
        quality_gate_failed: 0,
        near_or_over_budget: 0,
      };
      group.requests += 1;
      if (
        (log as CallLog & { intelligence_optimizer_applied?: boolean })
          .intelligence_optimizer_applied
      ) {
        group.optimizer_applied += 1;
      }
      group.estimated_savings_usd += Number(
        (
          log as CallLog & {
            intelligence_estimated_savings_usd?: number | null;
          }
        ).intelligence_estimated_savings_usd || 0,
      );
      if (
        (log as CallLog & { async_eval_queued?: boolean }).async_eval_queued
      ) {
        group.async_eval_queued += 1;
      }
      if (
        (log as CallLog & { quality_gate_status?: string | null })
          .quality_gate_status === "failed"
      ) {
        group.quality_gate_failed += 1;
      }
      const risk = (log as CallLog & { token_prediction_risk?: string | null })
        .token_prediction_risk;
      if (risk === "near_limit" || risk === "over_limit") {
        group.near_or_over_budget += 1;
      }
      groups.set(key, group);
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        estimated_savings_usd: Number(group.estimated_savings_usd.toFixed(6)),
      }))
      .sort(
        (a, b) =>
          b.estimated_savings_usd - a.estimated_savings_usd ||
          b.requests - a.requests ||
          a.key.localeCompare(b.key),
      )
      .slice(0, 12);
  }

  private countBy(values: string[]): Record<string, number> {
    return values.reduce<Record<string, number>>((acc, value) => {
      acc[value] = (acc[value] || 0) + 1;
      return acc;
    }, {});
  }

  private maskSecretHeaderRecord(
    headers: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!headers) return undefined;
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      sanitized[key] = this.isSensitiveHeader(key)
        ? maskSecretForDisplay(value)
        : value;
    }
    return sanitized;
  }

  private isSensitiveHeader(key: string): boolean {
    const lower = key.toLowerCase();
    return (
      [
        "authorization",
        "x-api-key",
        "api-key",
        "cookie",
        "set-cookie",
      ].includes(lower) ||
      /(^|[-_])(auth|token|secret|api[-_]?key)([-_]|$)/.test(lower)
    );
  }

  // ══════════════════════════════════════════════════════
  // Cost Analytics
  // ══════════════════════════════════════════════════════

  @Get("analytics/cost")
  @ApiOperation({ summary: "Get cost analytics for Dashboard charts" })
  @ApiQuery({ name: "period", required: false, example: "7d" })
  @ApiQuery({ name: "groupBy", required: false, example: "model" })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "namespace", required: false })
  @ApiOkResponse({
    description: "Cost totals, daily trend, and grouped usage analytics.",
  })
  async getCostAnalytics(
    @Query("period") period: string = "7d",
    @Query("groupBy") _groupBy: string = "model",
    @Query("api_key") apiKey?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("namespace") namespaceId?: string,
  ) {
    // Parse period
    const periodDays = period === "90d" ? 90 : period === "30d" ? 30 : 7;
    const since = new Date(Date.now() - periodDays * 86_400_000);

    // Daily cost trend
    const dailyTrendQb = this.callLogRepo
      .createQueryBuilder("log")
      .where("log.timestamp >= :since", { since })
      .select(this.dateTruncDay("log.timestamp"), "date")
      .addSelect("COUNT(*)", "calls")
      .addSelect("SUM(log.cost_usd)", "cost")
      .addSelect("SUM(log.input_tokens)", "inputTokens")
      .addSelect("SUM(log.output_tokens)", "outputTokens")
      .groupBy("date")
      .orderBy("date", "ASC");
    this.applyLogScopeFilter(dailyTrendQb, apiKey, apiKeyId, namespaceId);
    const dailyTrend = await dailyTrendQb.getRawMany();

    // Group by model
    const byModelQb = this.callLogRepo
      .createQueryBuilder("log")
      .where("log.timestamp >= :since", { since })
      .select("log.model", "model")
      .addSelect("COUNT(*)", "calls")
      .addSelect("SUM(log.cost_usd)", "cost")
      .addSelect("SUM(log.input_tokens)", "inputTokens")
      .addSelect("SUM(log.output_tokens)", "outputTokens")
      .addSelect("AVG(log.latency_ms)", "avgLatency")
      .groupBy("log.model")
      .orderBy("cost", "DESC");
    this.applyLogScopeFilter(byModelQb, apiKey, apiKeyId, namespaceId);
    const byModel = await byModelQb.getRawMany();

    // Group by node
    const byNodeQb = this.callLogRepo
      .createQueryBuilder("log")
      .where("log.timestamp >= :since", { since })
      .select("log.node_id", "nodeId")
      .addSelect("COUNT(*)", "calls")
      .addSelect("SUM(log.cost_usd)", "cost")
      .addSelect("SUM(log.input_tokens)", "inputTokens")
      .addSelect("SUM(log.output_tokens)", "outputTokens")
      .addSelect("AVG(log.latency_ms)", "avgLatency")
      .groupBy("log.node_id")
      .orderBy("cost", "DESC");
    this.applyLogScopeFilter(byNodeQb, apiKey, apiKeyId, namespaceId);
    const byNode = await byNodeQb.getRawMany();

    // Group by tier
    const byTierQb = this.callLogRepo
      .createQueryBuilder("log")
      .where("log.timestamp >= :since", { since })
      .select("log.tier", "tier")
      .addSelect("COUNT(*)", "calls")
      .addSelect("SUM(log.cost_usd)", "cost")
      .addSelect("SUM(log.input_tokens)", "inputTokens")
      .addSelect("SUM(log.output_tokens)", "outputTokens")
      .groupBy("log.tier")
      .orderBy("cost", "DESC");
    this.applyLogScopeFilter(byTierQb, apiKey, apiKeyId, namespaceId);
    const byTier = await byTierQb.getRawMany();

    // Total for the period
    const totalQb = this.callLogRepo
      .createQueryBuilder("log")
      .where("log.timestamp >= :since", { since })
      .select("COUNT(*)", "calls")
      .addSelect("SUM(log.cost_usd)", "cost")
      .addSelect("SUM(log.input_tokens)", "inputTokens")
      .addSelect("SUM(log.output_tokens)", "outputTokens")
      .addSelect("AVG(log.cost_usd)", "avgCostPerCall")
      .addSelect("SUM(log.cache_creation_input_tokens)", "cacheCreationTokens")
      .addSelect("SUM(log.cache_read_input_tokens)", "cacheReadTokens");
    this.applyLogScopeFilter(totalQb, apiKey, apiKeyId, namespaceId);
    const totalAgg = await totalQb.getRawOne();

    return {
      period: periodDays,
      total: {
        calls: Number(totalAgg?.calls || 0),
        cost: Number(Number(totalAgg?.cost || 0).toFixed(6)),
        inputTokens: Number(totalAgg?.inputTokens || 0),
        outputTokens: Number(totalAgg?.outputTokens || 0),
        avgCostPerCall: Number(
          Number(totalAgg?.avgCostPerCall || 0).toFixed(6),
        ),
        cacheCreationTokens: Number(totalAgg?.cacheCreationTokens || 0),
        cacheReadTokens: Number(totalAgg?.cacheReadTokens || 0),
      },
      dailyTrend: dailyTrend.map((d) => ({
        date: d.date,
        calls: Number(d.calls),
        cost: Number(Number(d.cost || 0).toFixed(6)),
        inputTokens: Number(d.inputTokens || 0),
        outputTokens: Number(d.outputTokens || 0),
      })),
      byModel: byModel.map((m) => ({
        model: m.model,
        calls: Number(m.calls),
        cost: Number(Number(m.cost || 0).toFixed(6)),
        inputTokens: Number(m.inputTokens || 0),
        outputTokens: Number(m.outputTokens || 0),
        avgLatency: Number(Number(m.avgLatency || 0).toFixed(0)),
        avgCostPerCall:
          Number(m.calls) > 0
            ? Number((Number(m.cost || 0) / Number(m.calls)).toFixed(6))
            : 0,
      })),
      byNode: byNode.map((n) => ({
        nodeId: n.nodeId,
        calls: Number(n.calls),
        cost: Number(Number(n.cost || 0).toFixed(6)),
        inputTokens: Number(n.inputTokens || 0),
        outputTokens: Number(n.outputTokens || 0),
        avgLatency: Number(Number(n.avgLatency || 0).toFixed(0)),
        avgCostPerCall:
          Number(n.calls) > 0
            ? Number((Number(n.cost || 0) / Number(n.calls)).toFixed(6))
            : 0,
      })),
      byTier: byTier.map((t) => ({
        tier: t.tier,
        calls: Number(t.calls),
        cost: Number(Number(t.cost || 0).toFixed(6)),
        inputTokens: Number(t.inputTokens || 0),
        outputTokens: Number(t.outputTokens || 0),
      })),
    };
  }

  @Get("cache-savings")
  @ApiOperation({
    summary:
      "Get provider-cache savings summary, grouped rankings, and daily trend analytics",
  })
  @ApiQuery({ name: "period", required: false, enum: ["1d", "7d", "30d"] })
  @ApiQuery({
    name: "group_by",
    required: false,
    enum: ["node", "model", "namespace", "team", "api_key"],
  })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "namespace", required: false })
  @ApiQuery({ name: "team_id", required: false })
  @ApiOkResponse({
    description:
      "Provider-cache savings totals, grouped breakdowns, and daily trend data derived from privacy-safe call-log metadata.",
  })
  async getCacheSavings(
    @Query("period") period: string = "7d",
    @Query("group_by") groupBy: CacheSavingsGroupBy = "node",
    @Query("api_key") apiKey?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("namespace") namespaceId?: string,
    @Query("team_id") teamId?: string,
  ) {
    return this.cacheSavings.getSummary(period, groupBy, {
      api_key: apiKey,
      api_key_id: apiKeyId,
      namespace: namespaceId,
      team_id: teamId,
    });
  }

  // ══════════════════════════════════════════════════════
  // Experiment Analytics (A/B Split)
  // ══════════════════════════════════════════════════════

  @Get("analytics/experiment")
  @ApiOperation({ summary: "Get A/B split experiment analytics" })
  @ApiQuery({ name: "period", required: false, example: "7d" })
  @ApiQuery({ name: "tier", required: false, example: "standard" })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "namespace", required: false })
  @ApiOkResponse({
    description: "Experiment-group analytics and active split definitions.",
  })
  async getExperimentAnalytics(
    @Query("period") period: string = "7d",
    @Query("tier") tier?: string,
    @Query("api_key") apiKey?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("namespace") namespaceId?: string,
  ) {
    const periodDays = period === "90d" ? 90 : period === "30d" ? 30 : 7;
    const since = new Date(Date.now() - periodDays * 86_400_000);

    // 1. Aggregate by experiment_group
    let qb = this.callLogRepo
      .createQueryBuilder("log")
      .where("log.timestamp >= :since", { since })
      .andWhere("log.experiment_group IS NOT NULL");
    if (tier) {
      qb = qb.andWhere("log.tier = :tier", { tier });
    }
    qb = this.applyLogScopeFilter(qb, apiKey, apiKeyId, namespaceId);

    const byGroup = await qb
      .select("log.experiment_group", "experimentGroup")
      .addSelect("COUNT(*)", "calls")
      .addSelect("SUM(log.cost_usd)", "totalCost")
      .addSelect("AVG(log.cost_usd)", "avgCost")
      .addSelect("AVG(log.latency_ms)", "avgLatency")
      .addSelect("SUM(log.input_tokens + log.output_tokens)", "totalTokens")
      .addSelect(
        `SUM(CASE WHEN log.status_code < 400 THEN 1 ELSE 0 END)`,
        "successCount",
      )
      .groupBy("log.experiment_group")
      .getRawMany();

    // 2. Daily trend by experiment_group × date
    let trendQb = this.callLogRepo
      .createQueryBuilder("log")
      .where("log.timestamp >= :since", { since })
      .andWhere("log.experiment_group IS NOT NULL");
    if (tier) {
      trendQb = trendQb.andWhere("log.tier = :tier", { tier });
    }
    trendQb = this.applyLogScopeFilter(trendQb, apiKey, apiKeyId, namespaceId);

    const dailyTrend = await trendQb
      .select(this.dateTruncDay("log.timestamp"), "date")
      .addSelect("log.experiment_group", "experimentGroup")
      .addSelect("COUNT(*)", "calls")
      .addSelect("AVG(log.latency_ms)", "avgLatency")
      .addSelect("AVG(log.cost_usd)", "avgCost")
      .groupBy("date")
      .addGroupBy("log.experiment_group")
      .orderBy("date", "ASC")
      .getRawMany();

    // 3. Active split configurations
    const activeSplits: Record<string, unknown> = {};
    for (const [t, tc] of Object.entries(this.config.routing.tiers)) {
      if ((tc as any).split) {
        activeSplits[t] = (tc as any).split;
      }
    }

    return {
      byGroup: byGroup.map((g) => ({
        experimentGroup: g.experimentGroup,
        calls: Number(g.calls),
        totalCost: Number(Number(g.totalCost || 0).toFixed(6)),
        avgCost: Number(Number(g.avgCost || 0).toFixed(6)),
        avgLatency: Number(Number(g.avgLatency || 0).toFixed(0)),
        totalTokens: Number(g.totalTokens || 0),
        successCount: Number(g.successCount || 0),
        successRate:
          Number(g.calls) > 0
            ? Number(
                ((Number(g.successCount || 0) / Number(g.calls)) * 100).toFixed(
                  1,
                ),
              )
            : 0,
      })),
      dailyTrend: dailyTrend.map((d) => ({
        date: d.date,
        experimentGroup: d.experimentGroup,
        calls: Number(d.calls),
        avgLatency: Number(Number(d.avgLatency || 0).toFixed(0)),
        avgCost: Number(Number(d.avgCost || 0).toFixed(6)),
      })),
      activeSplits,
      period: periodDays,
    };
  }

  // ══════════════════════════════════════════════════════
  // Stats
  // ══════════════════════════════════════════════════════

  @Get("stats")
  @ApiOperation({ summary: "Get Dashboard aggregate stats" })
  @ApiQuery({ name: "period", required: false, example: "1d" })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "namespace", required: false })
  @ApiOkResponse({
    description:
      "Total calls, success rate, token usage, cost, latency, and distributions.",
  })
  async getStats(
    @Query("api_key") apiKey?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("namespace") namespaceId?: string,
    @Query("period") period: string = "1d",
  ): Promise<DashboardStatsResponse> {
    const normalizedPeriod = this.normalizeStatsPeriod(period);
    const now = Date.now();
    for (const [key, value] of this.statsCache) {
      if (value.expiresAt <= now) this.statsCache.delete(key);
    }
    const cacheKey = JSON.stringify([
      normalizeWorkspaceId(this.workspaceContext.currentWorkspaceId()),
      normalizedPeriod,
      apiKeyId || "",
      apiKeyId ? "" : apiKey || "",
      namespaceId || "",
    ]);
    const cached = this.statsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const existing = this.statsInFlight.get(cacheKey);
    if (existing) return existing;

    const refresh = this.computeStats(
      apiKey,
      apiKeyId,
      namespaceId,
      normalizedPeriod,
    )
      .then((value) => {
        if (this.statsCache.size >= 64) {
          const oldestKey = this.statsCache.keys().next().value;
          if (oldestKey) this.statsCache.delete(oldestKey);
        }
        this.statsCache.set(cacheKey, {
          expiresAt: Date.now() + 120_000,
          value,
        });
        return value;
      })
      .finally(() => {
        this.statsInFlight.delete(cacheKey);
      });
    this.statsInFlight.set(cacheKey, refresh);

    if (cached) {
      void refresh.catch((error) => {
        this.logger.warn(
          `Failed to refresh Dashboard stats: ${(error as Error).message}`,
        );
      });
      return cached.value;
    }
    return refresh;
  }

  private normalizeStatsPeriod(period: string): string {
    return ["1d", "7d", "30d", "90d"].includes(period) ? period : "1d";
  }

  private async computeStats(
    apiKey?: string,
    apiKeyId?: string,
    namespaceId?: string,
    period: string = "1d",
  ): Promise<DashboardStatsResponse> {
    const periodDays =
      period === "90d" ? 90 : period === "30d" ? 30 : period === "7d" ? 7 : 1;
    const since = new Date(Date.now() - periodDays * 86_400_000);
    const oneDayAgo = new Date(Date.now() - 86_400_000);

    if (this.sqliteAnalytics?.available) {
      return this.computeSqliteStats(
        apiKey,
        apiKeyId,
        namespaceId,
        periodDays,
        since,
        oneDayAgo,
      );
    }

    // Aggregations via raw query (works for both SQLite and Postgres)
    const aggQb = this.callLogRepo
      .createQueryBuilder("log")
      .where("log.timestamp >= :since", { since, oneDayAgo })
      .select("COUNT(*)", "totalCalls")
      .addSelect(
        "SUM(CASE WHEN log.status_code = 200 THEN 1 ELSE 0 END)",
        "successCalls",
      )
      .addSelect("SUM(log.input_tokens)", "totalInputTokens")
      .addSelect("SUM(log.output_tokens)", "totalOutputTokens")
      .addSelect("SUM(log.cost_usd)", "totalCost")
      .addSelect("AVG(log.latency_ms)", "avgLatency")
      .addSelect(
        "COUNT(DISTINCT COALESCE(log.session_id, log.session_key))",
        "uniqueSessions",
      )
      .addSelect("SUM(log.cache_creation_input_tokens)", "cacheCreationTokens")
      .addSelect("SUM(log.cache_read_input_tokens)", "cacheReadTokens")
      .addSelect(
        "SUM(CASE WHEN log.timestamp >= :oneDayAgo THEN 1 ELSE 0 END)",
        "recentCalls",
      )
      .addSelect(
        "SUM(CASE WHEN log.timestamp >= :oneDayAgo THEN log.cost_usd ELSE 0 END)",
        "recentCost",
      )
      .addSelect(
        "SUM(CASE WHEN log.timestamp >= :oneDayAgo THEN log.input_tokens + log.output_tokens ELSE 0 END)",
        "recentTokens",
      );
    this.applyLogScopeFilter(aggQb, apiKey, apiKeyId, namespaceId);
    // Tier distribution
    const tierQb = this.callLogRepo
      .createQueryBuilder("log")
      .where("log.timestamp >= :since", { since })
      .select("log.tier", "tier")
      .addSelect("COUNT(*)", "count")
      .groupBy("log.tier");
    this.applyLogScopeFilter(tierQb, apiKey, apiKeyId, namespaceId);
    // Node distribution
    const nodeQb = this.callLogRepo
      .createQueryBuilder("log")
      .where("log.timestamp >= :since", { since })
      .select("log.node_id", "nodeId")
      .addSelect("COUNT(*)", "count")
      .addSelect("AVG(log.latency_ms)", "avgLatency")
      .groupBy("log.node_id");
    this.applyLogScopeFilter(nodeQb, apiKey, apiKeyId, namespaceId);
    const [agg, tierDist, nodeDist] = await Promise.all([
      aggQb.getRawOne(),
      tierQb.getRawMany(),
      nodeQb.getRawMany(),
    ]);
    const totalCalls = Number(agg?.totalCalls || 0);
    const successCalls = Number(agg?.successCalls || 0);
    const failedCalls = totalCalls - successCalls;

    return {
      period: periodDays,
      total: {
        calls: totalCalls,
        success: successCalls,
        failed: failedCalls,
        successRate:
          totalCalls > 0
            ? Number(((successCalls / totalCalls) * 100).toFixed(1))
            : 0,
        inputTokens: Number(agg?.totalInputTokens || 0),
        outputTokens: Number(agg?.totalOutputTokens || 0),
        totalTokens:
          Number(agg?.totalInputTokens || 0) +
          Number(agg?.totalOutputTokens || 0),
        costUsd: Number(Number(agg?.totalCost || 0).toFixed(6)),
        avgLatencyMs: Number(Number(agg?.avgLatency || 0).toFixed(0)),
        uniqueSessions: Number(agg?.uniqueSessions || 0),
        cacheCreationTokens: Number(agg?.cacheCreationTokens || 0),
        cacheReadTokens: Number(agg?.cacheReadTokens || 0),
      },
      last24h: {
        calls: Number(agg?.recentCalls || 0),
        costUsd: Number(Number(agg?.recentCost || 0).toFixed(6)),
        tokens: Number(agg?.recentTokens || 0),
      },
      tierDistribution: tierDist.map((t) => ({
        tier: t.tier,
        count: Number(t.count),
      })),
      nodeDistribution: nodeDist.map((n) => ({
        nodeId: n.nodeId,
        count: Number(n.count),
        avgLatencyMs: Number(Number(n.avgLatency || 0).toFixed(0)),
      })),
    };
  }

  private async computeSqliteStats(
    apiKey: string | undefined,
    apiKeyId: string | undefined,
    namespaceId: string | undefined,
    periodDays: number,
    since: Date,
    oneDayAgo: Date,
  ): Promise<DashboardStatsResponse> {
    const where = ["workspace_id = ?", "timestamp >= ?"];
    const params: unknown[] = [
      normalizeWorkspaceId(this.workspaceContext.currentWorkspaceId()),
      this.sqliteDateTime(since),
    ];
    if (apiKeyId) {
      where.push("api_key_id = ?");
      params.push(apiKeyId);
    } else if (apiKey) {
      where.push("api_key_name = ?");
      params.push(apiKey);
    }
    if (namespaceId) {
      where.push("namespace_id = ?");
      params.push(namespaceId);
    }
    const whereSql = where.join(" AND ");
    const oneDay = this.sqliteDateTime(oneDayAgo);
    const rows = await this.sqliteAnalytics!.queryAll<Record<string, unknown>>(
      `WITH filtered AS MATERIALIZED (
        SELECT
          tier,
          node_id,
          status_code,
          input_tokens,
          output_tokens,
          cost_usd,
          latency_ms,
          session_id,
          session_key,
          cache_creation_input_tokens,
          cache_read_input_tokens,
          timestamp
        FROM call_logs
        WHERE ${whereSql}
      )
      SELECT
        'total' AS kind,
        '' AS groupKey,
        COUNT(*) AS totalCalls,
        SUM(CASE WHEN status_code = 200 THEN 1 ELSE 0 END) AS successCalls,
        SUM(input_tokens) AS totalInputTokens,
        SUM(output_tokens) AS totalOutputTokens,
        SUM(cost_usd) AS totalCost,
        AVG(latency_ms) AS avgLatency,
        COUNT(DISTINCT COALESCE(session_id, session_key)) AS uniqueSessions,
        SUM(cache_creation_input_tokens) AS cacheCreationTokens,
        SUM(cache_read_input_tokens) AS cacheReadTokens,
        SUM(CASE WHEN timestamp >= ? THEN 1 ELSE 0 END) AS recentCalls,
        SUM(CASE WHEN timestamp >= ? THEN cost_usd ELSE 0 END) AS recentCost,
        SUM(CASE WHEN timestamp >= ? THEN input_tokens + output_tokens ELSE 0 END) AS recentTokens
      FROM filtered
      UNION ALL
      SELECT
        'tier', tier, COUNT(*), NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL
      FROM filtered
      GROUP BY tier
      UNION ALL
      SELECT
        'node', node_id, COUNT(*), NULL, NULL, NULL, NULL, AVG(latency_ms),
        NULL, NULL, NULL, NULL, NULL, NULL
      FROM filtered
      GROUP BY node_id`,
      [...params, oneDay, oneDay, oneDay],
    );
    const aggregate = rows.find((row) => row.kind === "total");
    const tierRows = rows
      .filter((row) => row.kind === "tier")
      .map((row) => ({ tier: row.groupKey, count: row.totalCalls }));
    const nodeRows = rows
      .filter((row) => row.kind === "node")
      .map((row) => ({
        nodeId: row.groupKey,
        count: row.totalCalls,
        avgLatency: row.avgLatency,
      }));
    return this.serializeStats(aggregate, tierRows, nodeRows, periodDays);
  }

  private serializeStats(
    agg: Record<string, unknown> | undefined,
    tierDist: Record<string, unknown>[],
    nodeDist: Record<string, unknown>[],
    periodDays: number,
  ): DashboardStatsResponse {
    const totalCalls = Number(agg?.totalCalls || 0);
    const successCalls = Number(agg?.successCalls || 0);
    return {
      period: periodDays,
      total: {
        calls: totalCalls,
        success: successCalls,
        failed: totalCalls - successCalls,
        successRate:
          totalCalls > 0
            ? Number(((successCalls / totalCalls) * 100).toFixed(1))
            : 0,
        inputTokens: Number(agg?.totalInputTokens || 0),
        outputTokens: Number(agg?.totalOutputTokens || 0),
        totalTokens:
          Number(agg?.totalInputTokens || 0) +
          Number(agg?.totalOutputTokens || 0),
        costUsd: Number(Number(agg?.totalCost || 0).toFixed(6)),
        avgLatencyMs: Number(Number(agg?.avgLatency || 0).toFixed(0)),
        uniqueSessions: Number(agg?.uniqueSessions || 0),
        cacheCreationTokens: Number(agg?.cacheCreationTokens || 0),
        cacheReadTokens: Number(agg?.cacheReadTokens || 0),
      },
      last24h: {
        calls: Number(agg?.recentCalls || 0),
        costUsd: Number(Number(agg?.recentCost || 0).toFixed(6)),
        tokens: Number(agg?.recentTokens || 0),
      },
      tierDistribution: tierDist.map((row) => ({
        tier: String(row.tier || "unknown"),
        count: Number(row.count || 0),
      })),
      nodeDistribution: nodeDist.map((row) => ({
        nodeId: String(row.nodeId || "unknown"),
        count: Number(row.count || 0),
        avgLatencyMs: Number(Number(row.avgLatency || 0).toFixed(0)),
      })),
    };
  }

  private sqliteDateTime(value: Date): string {
    return value.toISOString().slice(0, 23).replace("T", " ");
  }

  // ══════════════════════════════════════════════════════
  // Sessions / Trace Correlation
  // ══════════════════════════════════════════════════════

  @Get("sessions")
  @ApiOperation({
    summary: "List request sessions from privacy-safe call-log metadata",
  })
  @ApiQuery({ name: "period", required: false, example: "24h" })
  @ApiQuery({ name: "namespace", required: false })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "model", required: false })
  @ApiQuery({ name: "source_format", required: false })
  @ApiQuery({ name: "agent_connector", required: false })
  @ApiQuery({ name: "agent_repo", required: false })
  @ApiQuery({ name: "agent_project", required: false })
  @ApiQuery({ name: "page", required: false, example: 1 })
  @ApiQuery({ name: "limit", required: false, example: 25 })
  @ApiOkResponse({
    description:
      "Session summaries grouped by session_id/session_key without prompts, responses, raw headers, provider keys, media bytes, or video bytes.",
  })
  async getSessions(
    @Query("period") period?: string,
    @Query("namespace") namespaceId?: string,
    @Query("api_key") apiKey?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("model") model?: string,
    @Query("source_format") sourceFormat?: string,
    @Query("agent_connector") agentConnector?: string,
    @Query("agent_repo") agentRepo?: string,
    @Query("agent_project") agentProject?: string,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number = 1,
    @Query("limit", new DefaultValuePipe(25), ParseIntPipe) limit: number = 25,
  ) {
    const window = this.sessionWindow(period, "24h");
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safePage = Math.max(page, 1);
    const scanLimit = Math.min(Math.max(safeLimit * safePage * 80, 500), 5000);

    const qb = this.callLogRepo
      .createQueryBuilder("log")
      .where(
        "(log.agent_session_id IS NOT NULL OR log.session_id IS NOT NULL OR log.session_key IS NOT NULL)",
      )
      .orderBy("log.timestamp", "DESC")
      .take(scanLimit);
    if (window.since)
      qb.andWhere("log.timestamp >= :since", { since: window.since });
    if (model) qb.andWhere("log.model = :model", { model });
    if (sourceFormat)
      qb.andWhere("log.source_format = :sourceFormat", { sourceFormat });
    if (agentConnector) {
      qb.andWhere("log.agent_connector = :agentConnector", { agentConnector });
    }
    if (agentRepo) qb.andWhere("log.agent_repo = :agentRepo", { agentRepo });
    if (agentProject) {
      qb.andWhere("log.agent_project = :agentProject", { agentProject });
    }
    this.applyLogScopeFilter(qb, apiKey, apiKeyId, namespaceId);

    const logs = await qb.getMany();
    const grouped = this.groupLogsBySession(logs);
    const summaries = [...grouped.entries()]
      .map(([sessionId, sessionLogs]) =>
        this.buildSessionSummary(sessionId, sessionLogs),
      )
      .sort(
        (a, b) =>
          new Date(b.last_seen_at).getTime() -
          new Date(a.last_seen_at).getTime(),
      );

    const total = summaries.length;
    const offset = (safePage - 1) * safeLimit;
    return {
      data: summaries.slice(offset, offset + safeLimit),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
      filters: {
        period: window.period,
        namespace_id: namespaceId || null,
        api_key_id: apiKeyId || null,
        api_key_name: apiKey || null,
        model: model || null,
        source_format: sourceFormat || null,
        agent_connector: agentConnector || null,
        agent_repo: agentRepo || null,
        agent_project: agentProject || null,
      },
      privacy: this.sessionPrivacySummary(),
    };
  }

  @Get("sessions/:sessionId")
  @ApiOperation({
    summary: "Get one session timeline correlated by request id",
  })
  @ApiParam({ name: "sessionId" })
  @ApiQuery({ name: "period", required: false, example: "7d" })
  @ApiQuery({ name: "namespace", required: false })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "model", required: false })
  @ApiQuery({ name: "source_format", required: false })
  @ApiQuery({ name: "agent_connector", required: false })
  @ApiQuery({ name: "agent_repo", required: false })
  @ApiQuery({ name: "agent_project", required: false })
  @ApiQuery({ name: "limit", required: false, example: 200 })
  @ApiOkResponse({
    description:
      "Session timeline enriched with route-decision, shadow-result, benchmark-ready, and guardrails metadata without request/response bodies.",
  })
  async getSessionDetail(
    @Param("sessionId") sessionId: string,
    @Query("period") period?: string,
    @Query("namespace") namespaceId?: string,
    @Query("api_key") apiKey?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("model") model?: string,
    @Query("source_format") sourceFormat?: string,
    @Query("agent_connector") agentConnector?: string,
    @Query("agent_repo") agentRepo?: string,
    @Query("agent_project") agentProject?: string,
    @Query("limit", new DefaultValuePipe(200), ParseIntPipe)
    limit: number = 200,
  ) {
    const window = this.sessionWindow(period, "7d");
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const qb = this.callLogRepo
      .createQueryBuilder("log")
      .where(
        "(log.agent_session_id = :sessionId OR log.session_id = :sessionId OR log.session_key = :sessionId)",
        {
          sessionId,
        },
      )
      .orderBy("log.timestamp", "ASC")
      .take(safeLimit);
    if (window.since)
      qb.andWhere("log.timestamp >= :since", { since: window.since });
    if (model) qb.andWhere("log.model = :model", { model });
    if (sourceFormat)
      qb.andWhere("log.source_format = :sourceFormat", { sourceFormat });
    if (agentConnector) {
      qb.andWhere("log.agent_connector = :agentConnector", { agentConnector });
    }
    if (agentRepo) qb.andWhere("log.agent_repo = :agentRepo", { agentRepo });
    if (agentProject) {
      qb.andWhere("log.agent_project = :agentProject", { agentProject });
    }
    this.applyLogScopeFilter(qb, apiKey, apiKeyId, namespaceId);

    const logs = await qb.getMany();
    if (logs.length === 0) {
      throw new HttpException("Session not found", HttpStatus.NOT_FOUND);
    }

    const requestIds = logs.map((log) => log.request_id);
    const decisions =
      requestIds.length > 0
        ? await this.routeDecisionRepo.find({
            where: workspaceFindWhereStrict(
              this.workspaceContext.currentWorkspaceId(),
              { request_id: In(requestIds) },
            ),
          })
        : [];
    const shadows =
      requestIds.length > 0
        ? await this.shadowTrafficRepo.find({
            where: workspaceFindWhereStrict(
              this.workspaceContext.currentWorkspaceId(),
              { request_id: In(requestIds) },
            ),
            order: { timestamp: "ASC" },
          })
        : [];
    const decisionsByRequest = new Map(
      decisions.map((decision) => [decision.request_id, decision]),
    );
    const shadowsByRequest = new Map<string, ShadowTrafficResult[]>();
    for (const row of shadows) {
      const rows = shadowsByRequest.get(row.request_id) || [];
      rows.push(row);
      shadowsByRequest.set(row.request_id, rows);
    }
    const guardrailsByRequest = this.guardrailsFindingsByRequest();

    const timeline = logs.map((log) =>
      this.serializeSessionTimelineEvent(
        log,
        decisionsByRequest.get(log.request_id) || null,
        shadowsByRequest.get(log.request_id) || [],
        guardrailsByRequest.get(log.request_id) || null,
      ),
    );

    return {
      session_id: sessionId,
      summary: this.buildSessionSummary(sessionId, logs),
      timeline,
      filters: {
        period: window.period,
        namespace_id: namespaceId || null,
        api_key_id: apiKeyId || null,
        api_key_name: apiKey || null,
        model: model || null,
        source_format: sourceFormat || null,
        agent_connector: agentConnector || null,
        agent_repo: agentRepo || null,
        agent_project: agentProject || null,
      },
      links: {
        route_decisions: timeline.filter((item) => item.has_route_decision)
          .length,
        shadow_results: timeline.reduce(
          (sum, item) => sum + item.shadow.count,
          0,
        ),
        guardrails_findings: timeline.reduce(
          (sum, item) => sum + item.guardrails.count,
          0,
        ),
      },
      privacy: this.sessionPrivacySummary(),
    };
  }

  // ══════════════════════════════════════════════════════
  // Call Logs (paginated)
  // ══════════════════════════════════════════════════════

  @Get("logs/summary")
  @ApiOperation({ summary: "Get aggregate call-log metrics and per-key usage" })
  @ApiQuery({ name: "tier", required: false })
  @ApiQuery({ name: "node", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "namespace", required: false })
  @ApiQuery({ name: "period", required: false, example: "today" })
  @ApiOkResponse({
    description:
      "Request, token, cost, success-rate, and cache-hit metrics for the selected log filters, including a per-key breakdown and a zero-filled 24-hour trend when period=today.",
  })
  async getLogsSummary(
    @Query("tier") tier?: string,
    @Query("node") node?: string,
    @Query("status") status?: string,
    @Query("api_key") apiKey?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("namespace") namespaceId?: string,
    @Query("period") period?: string,
  ) {
    const keyGroupExpression =
      "COALESCE(log.api_key_id, log.api_key_name, '__unassigned__')";
    const cacheHitExpression = `CASE WHEN
      log.cache_read_input_tokens > 0
      OR log.semantic_cache_hit = :semanticCacheHit
      OR log.node_id IN (:...cacheNodeIds)
      OR log.tier = :cacheTier
      THEN 1 ELSE 0 END`;
    const qb = this.callLogRepo
      .createQueryBuilder("log")
      .select(keyGroupExpression, "keyGroup")
      .addSelect("MAX(log.api_key_id)", "apiKeyId")
      .addSelect("MAX(log.api_key_name)", "apiKeyName")
      .addSelect("COUNT(*)", "requestCount")
      .addSelect("SUM(log.input_tokens)", "inputTokens")
      .addSelect("SUM(log.output_tokens)", "outputTokens")
      .addSelect("SUM(log.cost_usd)", "costUsd")
      .addSelect(
        `SUM(CASE WHEN
          log.status_code = 200
          OR (log.status_code = 499 AND log.error = 'client_closed_after_tool_call')
          THEN 1 ELSE 0 END)`,
        "successCount",
      )
      .addSelect(`SUM(${cacheHitExpression})`, "cacheHitCount")
      .setParameters({
        semanticCacheHit: true,
        cacheNodeIds: ["cache", "semantic_cache"],
        cacheTier: "cached",
      })
      .groupBy(keyGroupExpression)
      .orderBy("requestCount", "DESC");

    const normalizedPeriod = this.normalizeLogPeriod(period);
    const since = this.logSinceFromPeriod(period);
    if (since) qb.andWhere("log.timestamp >= :since", { since });
    if (normalizedPeriod === "today" && since) {
      const until = new Date(since);
      until.setDate(until.getDate() + 1);
      qb.andWhere("log.timestamp < :until", { until });
    }
    if (tier) qb.andWhere("log.tier = :tier", { tier });
    if (node) qb.andWhere("log.node_id = :node", { node });
    if (status) {
      qb.andWhere("log.status_code = :status", { status: Number(status) });
    }
    this.applyLogScopeFilter(qb, apiKey, apiKeyId, namespaceId);

    const hourlyTrendPromise =
      normalizedPeriod === "today"
        ? this.getTodayHourlyLogTrend({
            tier,
            node,
            status,
            apiKey,
            apiKeyId,
            namespaceId,
          })
        : Promise.resolve([]);
    const [rows, hourlyTrend] = await Promise.all([
      qb.getRawMany<{
        apiKeyId: string | null;
        apiKeyName: string | null;
        requestCount: string | number | null;
        inputTokens: string | number | null;
        outputTokens: string | number | null;
        costUsd: string | number | null;
        successCount: string | number | null;
        cacheHitCount: string | number | null;
      }>(),
      hourlyTrendPromise,
    ]);

    const byKey = rows.map((row) => {
      const requests = Number(row.requestCount || 0);
      const inputTokens = Number(row.inputTokens || 0);
      const outputTokens = Number(row.outputTokens || 0);
      const successes = Number(row.successCount || 0);
      const cacheHits = Number(row.cacheHitCount || 0);
      return {
        api_key_id: row.apiKeyId || null,
        api_key_name: row.apiKeyName || null,
        requests,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tokens: inputTokens + outputTokens,
        cost_usd: Number(Number(row.costUsd || 0).toFixed(6)),
        successes,
        success_rate:
          requests > 0 ? Number(((successes / requests) * 100).toFixed(1)) : 0,
        cache_hits: cacheHits,
        cache_rate:
          requests > 0 ? Number(((cacheHits / requests) * 100).toFixed(1)) : 0,
      };
    });

    const total = byKey.reduce(
      (summary, row) => {
        summary.requests += row.requests;
        summary.input_tokens += row.input_tokens;
        summary.output_tokens += row.output_tokens;
        summary.tokens += row.tokens;
        summary.cost_usd += row.cost_usd;
        summary.successes += row.successes;
        summary.cache_hits += row.cache_hits;
        return summary;
      },
      {
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        tokens: 0,
        cost_usd: 0,
        successes: 0,
        success_rate: 0,
        cache_hits: 0,
        cache_rate: 0,
      },
    );
    total.cost_usd = Number(total.cost_usd.toFixed(6));
    total.success_rate =
      total.requests > 0
        ? Number(((total.successes / total.requests) * 100).toFixed(1))
        : 0;
    total.cache_rate =
      total.requests > 0
        ? Number(((total.cache_hits / total.requests) * 100).toFixed(1))
        : 0;

    return {
      period: normalizedPeriod,
      total,
      by_key: byKey,
      hourly_trend: hourlyTrend,
    };
  }

  private async getTodayHourlyLogTrend(filters: {
    tier?: string;
    node?: string;
    status?: string;
    apiKey?: string;
    apiKeyId?: string;
    namespaceId?: string;
  }) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const boundaries = Array.from({ length: 25 }, (_, hour) => {
      const boundary = new Date(dayStart);
      boundary.setHours(hour, 0, 0, 0);
      return boundary;
    });
    const parameters: Record<string, Date> = {};
    const bucketCases = Array.from({ length: 24 }, (_, hour) => {
      parameters[`hourStart${hour}`] = boundaries[hour];
      parameters[`hourEnd${hour}`] = boundaries[hour + 1];
      return `WHEN log.timestamp >= :hourStart${hour} AND log.timestamp < :hourEnd${hour} THEN ${hour}`;
    });
    const hourExpression = `CASE ${bucketCases.join(" ")} ELSE NULL END`;
    const qb = this.callLogRepo
      .createQueryBuilder("log")
      .select(hourExpression, "hour")
      .addSelect("COUNT(*)", "requestCount")
      .addSelect("SUM(log.input_tokens)", "inputTokens")
      .addSelect("SUM(log.output_tokens)", "outputTokens")
      .addSelect("SUM(log.cost_usd)", "costUsd")
      .where("log.timestamp >= :trendStart AND log.timestamp < :trendEnd", {
        trendStart: boundaries[0],
        trendEnd: boundaries[24],
      })
      .setParameters(parameters)
      // Group by the selected alias rather than repeating the parameterized
      // CASE expression. PostgreSQL assigns positional placeholders per
      // occurrence, so repeating it can make SELECT and GROUP BY appear
      // different even though they use the same named parameters.
      .groupBy("hour")
      .orderBy("hour", "ASC");

    if (filters.tier) {
      qb.andWhere("log.tier = :tier", { tier: filters.tier });
    }
    if (filters.node) {
      qb.andWhere("log.node_id = :node", { node: filters.node });
    }
    if (filters.status) {
      qb.andWhere("log.status_code = :status", {
        status: Number(filters.status),
      });
    }
    this.applyLogScopeFilter(
      qb,
      filters.apiKey,
      filters.apiKeyId,
      filters.namespaceId,
    );

    const rows = await qb.getRawMany<{
      hour: string | number | null;
      requestCount: string | number | null;
      inputTokens: string | number | null;
      outputTokens: string | number | null;
      costUsd: string | number | null;
    }>();
    const rowsByHour = new Map(
      rows
        .map((row) => [Number(row.hour), row] as const)
        .filter(([hour]) => Number.isInteger(hour) && hour >= 0 && hour <= 23),
    );

    return Array.from({ length: 24 }, (_, hour) => {
      const row = rowsByHour.get(hour);
      const inputTokens = Number(row?.inputTokens || 0);
      const outputTokens = Number(row?.outputTokens || 0);
      return {
        hour,
        requests: Number(row?.requestCount || 0),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tokens: inputTokens + outputTokens,
        cost_usd: Number(Number(row?.costUsd || 0).toFixed(6)),
      };
    });
  }

  @Get("logs")
  @ApiOperation({ summary: "List paginated call logs" })
  @ApiQuery({ name: "page", required: false, example: 1 })
  @ApiQuery({ name: "limit", required: false, example: 50 })
  @ApiQuery({ name: "tier", required: false })
  @ApiQuery({ name: "node", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "namespace", required: false })
  @ApiQuery({ name: "period", required: false, example: "7d" })
  @ApiOkResponse({
    description: "Paginated call logs and pagination metadata.",
  })
  async getLogs(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query("tier") tier?: string,
    @Query("node") node?: string,
    @Query("status") status?: string,
    @Query("api_key") apiKey?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("namespace") namespaceId?: string,
    @Query("period") period?: string,
  ) {
    const qb = this.callLogRepo
      .createQueryBuilder("log")
      .orderBy("log.timestamp", "DESC")
      .addOrderBy("log.id", "DESC");

    const since = this.logSinceFromPeriod(period);
    if (since) qb.andWhere("log.timestamp >= :since", { since });
    if (tier) qb.andWhere("log.tier = :tier", { tier });
    if (node) qb.andWhere("log.node_id = :node", { node });
    if (status)
      qb.andWhere("log.status_code = :status", { status: Number(status) });
    this.applyLogScopeFilter(qb, apiKey, apiKeyId, namespaceId);

    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const safePage = Math.max(page, 1);

    const [logs, total] = await qb
      .skip((safePage - 1) * safeLimit)
      .take(safeLimit)
      .getManyAndCount();

    return {
      data: logs.map((log) => this.enrichCallLogCostEstimates(log)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  @Get("route-decisions")
  @ApiOperation({
    summary: "List route decision traces for explainable routing",
  })
  @ApiQuery({ name: "page", required: false, example: 1 })
  @ApiQuery({ name: "limit", required: false, example: 50 })
  @ApiQuery({ name: "tier", required: false })
  @ApiQuery({ name: "node", required: false })
  @ApiQuery({ name: "source_format", required: false })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "namespace", required: false })
  @ApiOkResponse({ description: "Paginated route decision summaries." })
  async getRouteDecisions(
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query("tier") tier?: string,
    @Query("node") node?: string,
    @Query("source_format") sourceFormat?: string,
    @Query("api_key") apiKey?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("namespace") namespaceId?: string,
  ) {
    const qb = this.routeDecisionRepo
      .createQueryBuilder("decision")
      // The trace payload can be several KB per decision. Fetch it only from
      // the detail endpoint so listing a large history stays responsive.
      .select([
        "decision.id",
        "decision.request_id",
        "decision.timestamp",
        "decision.source_format",
        "decision.tier",
        "decision.score",
        "decision.route_mode",
        "decision.strategy",
        "decision.selected_node_id",
        "decision.selected_model",
        "decision.domain_hint",
        "decision.candidate_count",
        "decision.filtered_count",
        "decision.status_code",
        "decision.is_fallback",
        "decision.fallback_reason",
        "decision.session_id",
        "decision.trace_id",
        "decision.api_key_name",
        "decision.api_key_id",
        "decision.namespace_id",
        "decision.agent_connector",
        "decision.agent_profile_id",
        "decision.agent_profile_name",
        "decision.agent_virtual_model",
        "decision.agent_requested_model",
        "decision.agent_session_id",
        "decision.agent_turn_id",
        "decision.agent_repo",
        "decision.agent_project",
      ])
      .orderBy("decision.timestamp", "DESC")
      .addOrderBy("decision.id", "DESC");

    if (tier) qb.andWhere("decision.tier = :tier", { tier });
    if (node) qb.andWhere("decision.selected_node_id = :node", { node });
    if (sourceFormat) {
      qb.andWhere("decision.source_format = :sourceFormat", { sourceFormat });
    }
    this.applyRouteDecisionScopeFilter(qb, apiKey, apiKeyId, namespaceId);

    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const safePage = Math.max(page, 1);
    const [items, total] = await qb
      .skip((safePage - 1) * safeLimit)
      .take(safeLimit)
      .getManyAndCount();

    return {
      data: items.map((item) => this.serializeRouteDecision(item, false)),
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  @Get("route-decisions/:requestId")
  @ApiOperation({ summary: "Get one route decision trace by request id" })
  @ApiParam({ name: "requestId" })
  @ApiOkResponse({ description: "Full route decision trace for one request." })
  async getRouteDecision(@Param("requestId") requestId: string) {
    const item = await this.routeDecisionRepo.findOne({
      where: workspaceFindWhereStrict(
        this.workspaceContext.currentWorkspaceId(),
        {
          request_id: requestId,
        },
      ),
    });
    if (!item) {
      throw new HttpException("Route decision not found", HttpStatus.NOT_FOUND);
    }
    return this.serializeRouteDecision(item, true);
  }

  // ── Log Export ──────────────────────────────────────────

  @Get("logs/export")
  @ApiOperation({ summary: "Export call logs as CSV or JSON" })
  @ApiQuery({ name: "format", required: false, enum: ["csv", "json"] })
  @ApiQuery({ name: "period", required: false, example: "7d" })
  @ApiQuery({ name: "days", required: false, example: 7 })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "namespace", required: false })
  @ApiOkResponse({ description: "A CSV or JSON file download." })
  async exportLogs(
    @Query("format") format: string = "csv",
    @Query("period") period: string | undefined,
    @Query("days", new DefaultValuePipe(7), ParseIntPipe) days: number,
    @Query("api_key") apiKey: string | undefined,
    @Query("api_key_id") apiKeyId: string | undefined,
    @Query("namespace") namespaceId: string | undefined,
    @Res() res: Response,
  ) {
    const safeDays = Math.min(Math.max(days, 1), 365);
    const exportPeriod = this.normalizeLogPeriod(period) || `${safeDays}d`;
    const since =
      this.logSinceFromPeriod(exportPeriod) ||
      new Date(Date.now() - safeDays * 86_400_000);

    const qb = this.callLogRepo
      .createQueryBuilder("log")
      .where("log.timestamp >= :since", { since })
      .orderBy("log.timestamp", "DESC");
    this.applyLogScopeFilter(qb, apiKey, apiKeyId, namespaceId);
    const logs = (await qb.getMany()).map((log) =>
      this.enrichCallLogCostEstimates(log),
    );

    if (format === "json") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="logs-${exportPeriod}.json"`,
      );
      res.send(JSON.stringify(logs, null, 2));
      return;
    }

    // CSV
    const headers = [
      "timestamp",
      "request_id",
      "client_source",
      "tier",
      "score",
      "node_id",
      "model",
      "source_format",
      "input_tokens",
      "output_tokens",
      "cost_usd",
      "cost_without_cache_usd",
      "latency_ms",
      "status_code",
      "is_fallback",
      "session_key",
      "fallback_reason",
      "structured_output_requested",
      "structured_output_type",
      "structured_output_strategy",
      "structured_output_supported",
      "structured_output_schema_name",
      "reasoning_requested",
      "reasoning_effort",
      "reasoning_strategy",
      "reasoning_supported",
      "reasoning_budget_tokens",
      "reasoning_source",
      "reasoning_reason",
      "media_type",
      "media_operation",
      "media_multipart",
      "media_file_count",
      "media_byte_size",
      "media_requested_format",
      "media_response_format",
      "media_provider_response_type",
      "api_key_id",
      "api_key_name",
      "team_id",
      "retry_count",
      "error",
      "namespace_id",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ];
    const csvRows = [headers.join(",")];

    for (const log of logs) {
      const row = headers.map((h) => {
        const val = (log as unknown as Record<string, unknown>)[h];
        if (val === null || val === undefined) return "";
        const str = String(val);
        // Escape CSV fields containing commas/quotes/newlines
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      });
      csvRows.push(row.join(","));
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="logs-${exportPeriod}.csv"`,
    );
    res.send(csvRows.join("\n"));
  }

  private enrichCallLogCostEstimates(log: CallLog): CallLog {
    // Historical amounts are evidence, not a view recomputed at today's prices.
    // Explicit what-if replay lives in the pricing API and never rewrites these fields.
    return log;
  }

  private normalizeLogPeriod(period: string | undefined): string | null {
    const normalized = (period || "").trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === "today") return "today";
    if (/^\d+[mhd]$/.test(normalized)) return normalized;
    return null;
  }

  private logSinceFromPeriod(period: string | undefined): Date | null {
    const normalized = this.normalizeLogPeriod(period);
    if (!normalized) return null;
    if (normalized === "today") {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return start;
    }

    const amount = Number(normalized.slice(0, -1));
    const unit = normalized.slice(-1);
    const multiplier =
      unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - amount * multiplier);
  }

  // ══════════════════════════════════════════════════════
  // SSE — Real-time Log Stream
  // ══════════════════════════════════════════════════════

  @Sse("logs/sse")
  @ApiOperation({ summary: "Stream call log events for the Dashboard" })
  @ApiOkResponse({
    description:
      "Server-Sent Events with connected, activity, log, and heartbeat events.",
  })
  streamLogs(): Observable<MessageEvent> {
    // Heartbeat every 30s to keep connection alive
    const heartbeat$ = interval(30_000).pipe(
      map(
        () =>
          ({
            data: { type: "heartbeat", timestamp: new Date().toISOString() },
          }) as MessageEvent,
      ),
    );

    // New log events from the shared event bus
    const workspaceId = this.workspaceContext.currentWorkspaceId();
    const logs$ = this.logEventBus.events$.pipe(
      filter((log) => log.workspace_id === workspaceId),
      map((log) => ({ data: { type: "log", log } }) as MessageEvent),
    );

    const activity$ = this.logEventBus.activityEvents$.pipe(
      filter((activity) => activity.workspace_id === workspaceId),
      map(
        (activity) =>
          ({
            data: { type: "activity", activity },
          }) as MessageEvent,
      ),
    );

    // Send an initial connected event
    const connected$ = new Observable<MessageEvent>((subscriber) => {
      subscriber.next({
        data: { type: "connected", timestamp: new Date().toISOString() },
      } as MessageEvent);
    });

    return merge(connected$, activity$, logs$, heartbeat$);
  }

  // ══════════════════════════════════════════════════════
  // Budget
  // ══════════════════════════════════════════════════════

  @Get("budget")
  @ApiOperation({ summary: "Get global and per-key budget status" })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "namespace", required: false })
  @ApiQuery({ name: "team_id", required: false })
  @ApiOkResponse({ description: "Budget rules and current usage." })
  async getBudget(
    @Query("api_key") apiKey?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("namespace") namespaceId?: string,
    @Query("team_id") teamId?: string,
  ) {
    const globalStatus = await this.budgetService.getStatus();
    if (teamId) {
      const teamStatus = await this.budgetService.getStatus(
        null,
        null,
        null,
        teamId,
      );
      return {
        rules: globalStatus.map((s) => this.serializeBudgetStatus(s)),
        teamRules: teamStatus.map((s) => this.serializeBudgetStatus(s)),
        teamId,
        selectedScope: this.serializeBudgetSelectedScope(
          "team",
          teamStatus,
          teamId,
        ),
        scopeChain: this.serializeBudgetScopeChain("team"),
      };
    }
    if (namespaceId) {
      const namespaceStatus = await this.budgetService.getStatus(
        null,
        null,
        namespaceId,
      );
      return {
        rules: globalStatus.map((s) => this.serializeBudgetStatus(s)),
        namespaceRules: namespaceStatus.map((s) =>
          this.serializeBudgetStatus(s),
        ),
        namespaceId,
        selectedScope: this.serializeBudgetSelectedScope(
          "namespace",
          namespaceStatus,
          namespaceId,
        ),
        scopeChain: this.serializeBudgetScopeChain("namespace"),
      };
    }
    if (apiKey || apiKeyId) {
      const keyStatus = await this.budgetService.getStatus(
        apiKey || null,
        apiKeyId || null,
      );
      return {
        rules: globalStatus.map((s) => this.serializeBudgetStatus(s)),
        perKeyRules: keyStatus.map((s) => this.serializeBudgetStatus(s)),
        apiKeyName: keyStatus[0]?.apiKeyName || apiKey || null,
        apiKeyId: keyStatus[0]?.apiKeyId || apiKeyId || null,
        selectedScope: this.serializeBudgetSelectedScope(
          "api_key",
          keyStatus,
          keyStatus[0]?.apiKeyName || apiKey || apiKeyId || null,
        ),
        scopeChain: this.serializeBudgetScopeChain("api_key"),
      };
    }
    // Backward-compatible: no api_key → global rules only
    return {
      rules: globalStatus.map((s) => this.serializeBudgetStatus(s)),
      selectedScope: this.serializeBudgetSelectedScope(
        "global",
        globalStatus,
        "global",
      ),
      scopeChain: this.serializeBudgetScopeChain("global"),
    };
  }

  private serializeBudgetStatus(s: {
    id: number;
    type: string;
    scope: BudgetScopeKind;
    apiKeyName: string | null;
    apiKeyId: string | null;
    namespaceId: string | null;
    teamId?: string | null;
    limit: number;
    current: number;
    percentage: number;
    alertThreshold?: number;
    isExceeded: boolean;
    isAlert: boolean;
    periodStart: Date;
    resetAt: Date | null;
  }) {
    const sourceOfTruth = BUDGET_SOURCE_OF_TRUTH[s.scope];
    const blockingOrder = BUDGET_SCOPE_ORDER.indexOf(s.scope) + 1;
    return {
      id: s.id,
      type: s.type,
      scope: s.scope,
      scopeLabel: BUDGET_SCOPE_LABEL[s.scope],
      sourceOfTruth,
      source: sourceOfTruth,
      editableVia: BUDGET_EDITABLE_VIA[s.scope],
      inherited: false,
      unset: false,
      blockingOrder,
      blockingRuleScope: s.scope,
      apiKeyName: s.apiKeyName,
      apiKeyId: s.apiKeyId,
      namespaceId: s.namespaceId,
      teamId: s.teamId ?? null,
      limit: s.limit,
      current: this.serializeBudgetCurrent(s.type, s.current),
      percentage: Number((s.percentage * 100).toFixed(1)),
      alertThreshold: Number(((s.alertThreshold ?? 0.8) * 100).toFixed(1)),
      exceeded: s.isExceeded,
      alert: s.isAlert,
      periodStart: s.periodStart,
      resetAt: s.resetAt,
      dailyResetAt: s.resetAt,
    };
  }

  private serializeBudgetSelectedScope(
    scope: BudgetScopeKind,
    rules: Array<{
      resetAt: Date | null;
      isExceeded: boolean;
      alertThreshold?: number;
    }>,
    targetId: string | null,
  ) {
    return {
      scope,
      label: BUDGET_SCOPE_LABEL[scope],
      targetId,
      sourceOfTruth: BUDGET_SOURCE_OF_TRUTH[scope],
      editableVia: BUDGET_EDITABLE_VIA[scope],
      configured: rules.length > 0,
      inherited: scope !== "global" && rules.length === 0,
      unset: scope === "global" && rules.length === 0,
      blockingOrder: BUDGET_SCOPE_ORDER.indexOf(scope) + 1,
      blockingRuleScope: rules.some((rule) => rule.isExceeded) ? scope : null,
      dailyResetAt: rules.find((rule) => rule.resetAt)?.resetAt ?? null,
      alertThreshold:
        rules[0]?.alertThreshold !== undefined
          ? Number((rules[0].alertThreshold * 100).toFixed(1))
          : null,
    };
  }

  private serializeBudgetScopeChain(selected: BudgetScopeKind) {
    const selectedIndex = BUDGET_SCOPE_ORDER.indexOf(selected);
    return BUDGET_SCOPE_ORDER.map((scope, index) => ({
      scope,
      label: BUDGET_SCOPE_LABEL[scope],
      sourceOfTruth: BUDGET_SOURCE_OF_TRUTH[scope],
      editableVia: BUDGET_EDITABLE_VIA[scope],
      blockingOrder: index + 1,
      activeForSelected: index <= selectedIndex,
    }));
  }

  private serializeBudgetCurrent(type: string, current: number): number {
    return Number(current.toFixed(type.includes("cost") ? 6 : 4));
  }

  @Get("budget/keys")
  @ApiOperation({ summary: "List API keys that have budget information" })
  @ApiOkResponse({
    description: "Budget-aware Gateway API key names and summaries.",
  })
  async getBudgetKeys() {
    const budgetKeys = await this.budgetService.getKeysWithBudgets();
    const generatedKeys = await this.gatewayApiKeys.list();
    return {
      keys: [
        ...new Set([...budgetKeys, ...generatedKeys.map((key) => key.name)]),
      ],
      items: generatedKeys.map((key) => ({
        id: key.id,
        name: key.name,
        key_prefix: key.key_prefix,
        daily_token_limit: key.daily_token_limit,
        daily_cost_limit: key.daily_cost_limit,
        rate_limit_per_minute: key.rate_limit_per_minute,
      })),
    };
  }

  @Get("namespaces")
  @ApiOperation({
    summary: "List local OSS Policy Namespaces and binding impact",
  })
  @ApiOkResponse({
    description:
      "Local Policy Namespace policies with budget status and bound API key/team summaries.",
  })
  async getNamespaces() {
    const namespaces = await Promise.all(
      this.config.namespaces.map(async (namespace) => {
        const budget = await this.budgetService.getStatus(
          null,
          null,
          namespace.id,
        );
        return {
          id: namespace.id,
          name: namespace.name || namespace.id,
          allowed_nodes: namespace.allowed_nodes || [],
          allowed_models: namespace.allowed_models || [],
          rate_limit_per_minute:
            namespace.rate_limit?.requests_per_minute || null,
          budget: namespace.budget || null,
          budget_status: budget.map((item) => this.serializeBudgetStatus(item)),
          bindings: await this.namespaceBindings(namespace.id),
        };
      }),
    );

    return {
      namespaces,
      counts: {
        total: namespaces.length,
        with_budget: namespaces.filter((namespace) => namespace.budget).length,
        with_rate_limit: namespaces.filter(
          (namespace) => namespace.rate_limit_per_minute !== null,
        ).length,
        bound_api_keys: namespaces.reduce(
          (sum, namespace) => sum + namespace.bindings.api_keys.length,
          0,
        ),
        bound_teams: namespaces.reduce(
          (sum, namespace) => sum + namespace.bindings.teams.length,
          0,
        ),
      },
      mode: "local_only",
      enterprise_features: {
        workspace: false,
        sso: false,
        scim: false,
        org_billing: false,
      },
    };
  }

  @Post("namespaces")
  @RequireDashboardRole("admin")
  @ApiTags("Policy Namespaces")
  @ApiOperation({ summary: "Create a config-backed Policy Namespace" })
  @ApiBody({ type: CreateNamespaceDto })
  @ApiOkResponse({ type: ActionResponseDto })
  async createNamespace(@Body() body: CreateNamespaceDto) {
    try {
      const namespace = this.namespaceInput(body);
      const result = await this.configAudit.trackChange(
        {
          action: "config.namespace.create",
          target: `namespace:${namespace.id}`,
          source: "dashboard",
          actor: { type: "dashboard", id: "dashboard" },
          metadata: this.namespaceMutationMetadata(namespace),
        },
        () => this.config.createNamespace(namespace),
      );
      this.activeHealth.refreshSchedules();
      return {
        success: true,
        message: `Policy Namespace "${namespace.id}" created`,
        item: await this.namespaceSummary(namespace.id),
        reload: result,
      };
    } catch (err) {
      throw new HttpException(
        { success: false, message: (err as Error).message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Put("namespaces/:id")
  @RequireDashboardRole("admin")
  @ApiTags("Policy Namespaces")
  @ApiOperation({ summary: "Update a config-backed Policy Namespace" })
  @ApiParam({ name: "id", example: "team-a" })
  @ApiBody({ type: UpdateNamespaceDto })
  @ApiOkResponse({ type: ActionResponseDto })
  async updateNamespace(
    @Param("id") id: string,
    @Body() body: UpdateNamespaceDto,
  ) {
    const before = this.config.getNamespace(id);
    if (!before) {
      throw new HttpException(
        { success: false, message: `Namespace "${id}" not found` },
        HttpStatus.NOT_FOUND,
      );
    }
    try {
      const updates = this.namespaceUpdateInput(body);
      const result = await this.configAudit.trackChange(
        {
          action: "config.namespace.update",
          target: `namespace:${id}`,
          source: "dashboard",
          actor: { type: "dashboard", id: "dashboard" },
          metadata: {
            fields: Object.keys(body || {}),
            before: this.namespaceAuditSummary(before),
          },
        },
        () => this.config.updateNamespace(id, updates),
      );
      this.activeHealth.refreshSchedules();
      return {
        success: true,
        message: `Policy Namespace "${id}" updated`,
        item: await this.namespaceSummary(id),
        reload: result,
      };
    } catch (err) {
      throw new HttpException(
        { success: false, message: (err as Error).message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete("namespaces/:id")
  @RequireDashboardRole("admin")
  @ApiTags("Policy Namespaces")
  @ApiOperation({
    summary:
      "Delete a config-backed Policy Namespace after explicit impact acknowledgement",
  })
  @ApiParam({ name: "id", example: "team-a" })
  @ApiBody({ type: DeleteNamespaceDto, required: false })
  @ApiOkResponse({ type: ActionResponseDto })
  async deleteNamespace(
    @Param("id") id: string,
    @Body() body: DeleteNamespaceDto = {},
  ) {
    const before = this.config.getNamespace(id);
    if (!before) {
      throw new HttpException(
        { success: false, message: `Namespace "${id}" not found` },
        HttpStatus.NOT_FOUND,
      );
    }

    const impact = await this.namespaceBindings(id);
    const impacted = impact.api_keys.length > 0 || impact.teams.length > 0;
    if (impacted && body?.confirm_impact !== true) {
      throw new HttpException(
        {
          success: false,
          message:
            "Policy Namespace is bound to API keys or teams. Resubmit with confirm_impact: true after reviewing impact.",
          impact,
        },
        HttpStatus.CONFLICT,
      );
    }

    try {
      const result = await this.configAudit.trackChange(
        {
          action: "config.namespace.delete",
          target: `namespace:${id}`,
          source: "dashboard",
          actor: { type: "dashboard", id: "dashboard" },
          metadata: {
            confirm_impact: body?.confirm_impact === true,
            impact,
          },
        },
        () => this.config.deleteNamespace(id),
      );
      this.activeHealth.refreshSchedules();
      return {
        success: true,
        message: `Policy Namespace "${id}" deleted`,
        impact,
        reload: result,
      };
    } catch (err) {
      throw new HttpException(
        { success: false, message: (err as Error).message, impact },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get("shadow")
  @ApiOperation({
    summary: "Read-only shadow traffic status and recent results",
  })
  @ApiQuery({ name: "namespace", required: false })
  @ApiQuery({ name: "limit", required: false, example: 50 })
  @ApiOkResponse({
    description:
      "Shadow traffic configuration status and sanitized recent result rows.",
  })
  async getShadowTraffic(
    @Query("namespace") namespaceId?: string,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit: number = 50,
  ) {
    return {
      status: this.shadowTraffic.getStatus(),
      recent: await this.shadowTraffic.recent(namespaceId, limit),
    };
  }

  @Get("shadow/report")
  @ApiOperation({ summary: "Read-only shadow traffic comparison report" })
  @ApiQuery({ name: "namespace", required: false })
  @ApiQuery({ name: "api_key", required: false })
  @ApiQuery({ name: "api_key_id", required: false })
  @ApiQuery({ name: "node", required: false })
  @ApiQuery({ name: "model", required: false })
  @ApiQuery({ name: "period", required: false, example: "7d" })
  @ApiQuery({ name: "source_format", required: false })
  @ApiOkResponse({
    description:
      "Privacy-safe aggregate comparison between primary and shadow traffic.",
  })
  async getShadowComparisonReport(
    @Query("namespace") namespaceId?: string,
    @Query("api_key") apiKeyName?: string,
    @Query("api_key_id") apiKeyId?: string,
    @Query("node") node?: string,
    @Query("model") model?: string,
    @Query("period") period?: string,
    @Query("source_format") sourceFormat?: string,
  ) {
    return this.shadowTraffic.comparisonReport({
      namespaceId,
      apiKeyName,
      apiKeyId,
      node,
      model,
      period,
      sourceFormat,
    });
  }

  @Get("shadow/results/:id/comparison")
  @ApiOperation({
    summary: "Read-only comparison detail for one shadow traffic result",
  })
  @ApiParam({ name: "id", type: Number })
  @ApiOkResponse({
    description:
      "Primary vs shadow metrics for a single mirrored request without raw prompts, responses, headers, or keys.",
  })
  async getShadowResultComparison(@Param("id", ParseIntPipe) id: number) {
    const comparison = await this.shadowTraffic.comparisonForResult(id);
    if (!comparison) {
      throw new HttpException("Shadow result not found", HttpStatus.NOT_FOUND);
    }
    return comparison;
  }

  @Get("teams")
  @ApiTags("Teams")
  @ApiOperation({ summary: "List local OSS teams and usage summaries" })
  @ApiOkResponse({
    description:
      "Local teams with policy, budget, rate-limit, and usage metadata.",
  })
  async getTeams() {
    const teams = await this.teams.list();
    return {
      teams,
      mode: "local_only",
      enterprise_features: {
        workspace: false,
        sso: false,
        scim: false,
        org_billing: false,
      },
    };
  }

  @Post("teams")
  @RequireDashboardRole("admin")
  @ApiTags("Teams")
  @ApiOperation({ summary: "Create a local OSS team policy" })
  @ApiBody({ type: CreateTeamDto })
  @ApiOkResponse({ type: ActionResponseDto })
  async createTeam(@Body() body: CreateTeamDto) {
    return this.teams.withTransaction(async (teams, manager) => {
      const created = await teams.create(body);
      await this.configAudit.recordManagementEvent(
        {
          action: "team.create",
          target: `team:${created.id}`,
          afterSummary: this.teamAuditSummary(created),
        },
        manager,
      );
      return {
        success: true,
        message: "Team created",
        item: created,
      };
    });
  }

  @Put("teams/:id")
  @RequireDashboardRole("admin")
  @ApiTags("Teams")
  @ApiOperation({ summary: "Update a local OSS team policy" })
  @ApiParam({ name: "id", example: "team_01h..." })
  @ApiBody({ type: UpdateTeamDto })
  @ApiOkResponse({ type: ActionResponseDto })
  async updateTeam(@Param("id") id: string, @Body() body: UpdateTeamDto) {
    return this.teams.withTransaction(async (teams, manager) => {
      const before = await teams.getSummary(id);
      const updated = await teams.update(id, body);
      await this.configAudit.recordManagementEvent(
        {
          action: "team.update",
          target: `team:${id}`,
          beforeSummary: this.teamAuditSummary(before),
          afterSummary: this.teamAuditSummary(updated),
          metadata: { fields: Object.keys(body || {}) },
        },
        manager,
      );
      return {
        success: true,
        message: "Team updated",
        item: updated,
      };
    });
  }

  @Delete("teams/:id")
  @RequireDashboardRole("admin")
  @ApiTags("Teams")
  @ApiOperation({ summary: "Delete a local OSS team policy" })
  @ApiParam({ name: "id", example: "team_01h..." })
  @ApiOkResponse({ type: ActionResponseDto })
  async deleteTeam(@Param("id") id: string) {
    return this.teams.withTransaction(async (teams, manager) => {
      const before = await teams.getSummary(id);
      await teams.remove(id);
      await this.configAudit.recordManagementEvent(
        {
          action: "team.delete",
          target: `team:${id}`,
          beforeSummary: this.teamAuditSummary(before),
        },
        manager,
      );
      return { success: true, message: "Team deleted" };
    });
  }

  @Get("api-keys")
  @ApiTags("API Keys")
  @ApiOperation({ summary: "List Dashboard-managed Gateway API keys" })
  @ApiOkResponse({ type: GatewayApiKeyListResponseDto })
  async getApiKeyNames() {
    const items = await this.gatewayApiKeys.list();
    return {
      keys: items.map((key) => key.name),
      items,
    };
  }

  @Post("api-keys")
  @RequireDashboardRole("admin")
  @ApiTags("API Keys")
  @ApiOperation({ summary: "Create a Gateway API key" })
  @ApiBody({ type: CreateGatewayApiKeyDto })
  @ApiOkResponse({ type: GatewayApiKeyCreatedResponseDto })
  async createApiKey(@Body() body: CreateGatewayApiKeyDto) {
    return this.gatewayApiKeys.withTransaction(
      async (gatewayApiKeys, manager) => {
        const created = await gatewayApiKeys.create(body);
        await this.configAudit.recordManagementEvent(
          {
            action: "api_key.create",
            target: `api_key:${created.item.id}`,
            afterSummary: this.apiKeyAuditSummary(created.item),
          },
          manager,
        );
        return {
          success: true,
          message: "Gateway API key created",
          key: created.key,
          item: created.item,
        };
      },
    );
  }

  @Put("api-keys/:id")
  @RequireDashboardRole("admin")
  @ApiTags("API Keys")
  @ApiOperation({ summary: "Update a Gateway API key policy" })
  @ApiParam({ name: "id", example: "key_01h..." })
  @ApiBody({ type: UpdateGatewayApiKeyDto })
  @ApiOkResponse({ type: GatewayApiKeyMutationResponseDto })
  async updateApiKey(
    @Param("id") id: string,
    @Body() body: UpdateGatewayApiKeyDto,
  ) {
    return this.gatewayApiKeys.withTransaction(
      async (gatewayApiKeys, manager) => {
        const before = await gatewayApiKeys.getSummary(id);
        const updated = await gatewayApiKeys.update(id, body);
        await this.configAudit.recordManagementEvent(
          {
            action: "api_key.update",
            target: `api_key:${id}`,
            beforeSummary: this.apiKeyAuditSummary(before),
            afterSummary: this.apiKeyAuditSummary(updated),
            metadata: { fields: Object.keys(body || {}) },
          },
          manager,
        );
        return {
          success: true,
          message: "Gateway API key updated",
          item: updated,
        };
      },
    );
  }

  @Post("api-keys/:id/rotate")
  @RequireDashboardRole("admin")
  @ApiTags("API Keys")
  @ApiOperation({ summary: "Rotate a Gateway API key secret" })
  @ApiParam({ name: "id", example: "key_01h..." })
  @ApiOkResponse({ type: GatewayApiKeyCreatedResponseDto })
  async rotateApiKey(@Param("id") id: string) {
    return this.gatewayApiKeys.withTransaction(
      async (gatewayApiKeys, manager) => {
        const before = await gatewayApiKeys.getSummary(id);
        const rotated = await gatewayApiKeys.rotate(id);
        await this.configAudit.recordManagementEvent(
          {
            action: "api_key.rotate",
            target: `api_key:${id}`,
            beforeSummary: this.apiKeyAuditSummary(before),
            afterSummary: this.apiKeyAuditSummary(rotated.item),
          },
          manager,
        );
        return {
          success: true,
          message: "Gateway API key rotated",
          key: rotated.key,
          item: rotated.item,
        };
      },
    );
  }

  @Delete("api-keys/:id")
  @RequireDashboardRole("admin")
  @ApiTags("API Keys")
  @ApiOperation({ summary: "Delete a Gateway API key" })
  @ApiParam({ name: "id", example: "key_01h..." })
  @ApiOkResponse({ type: ActionResponseDto })
  async deleteApiKey(@Param("id") id: string) {
    return this.gatewayApiKeys.withTransaction(
      async (gatewayApiKeys, manager) => {
        const before = await gatewayApiKeys.getSummary(id);
        await gatewayApiKeys.remove(id);
        await this.configAudit.recordManagementEvent(
          {
            action: "api_key.delete",
            target: `api_key:${id}`,
            beforeSummary: this.apiKeyAuditSummary(before),
          },
          manager,
        );
        return { success: true, message: "Gateway API key deleted" };
      },
    );
  }

  @Get("agent-profiles")
  @ApiTags("Agent Profiles")
  @ApiOperation({ summary: "List local Agent Gateway profiles" })
  @ApiOkResponse({ type: AgentProfileListResponseDto })
  async getAgentProfiles() {
    const items = await this.agentProfiles.list();
    return {
      items,
      connectors: [
        "cursor",
        "cline",
        "roo_code",
        "continue",
        "codex",
        "claude_code",
        "opencode",
        "generic_openai",
        "generic_anthropic",
        "cherry_studio",
        "hermes",
        "openclaw",
      ],
      mode: "local_only",
    };
  }

  @Post("agent-profiles")
  @RequireDashboardRole("operator")
  @ApiTags("Agent Profiles")
  @ApiOperation({ summary: "Create a local Agent Gateway profile" })
  @ApiBody({ type: CreateAgentProfileDto })
  @ApiOkResponse({ type: AgentProfileMutationResponseDto })
  async createAgentProfile(@Body() body: CreateAgentProfileDto) {
    const created = await this.agentProfiles.create(body);
    await this.configAudit.recordManagementEvent({
      action: "agent_profile.create",
      target: `agent_profile:${created.id}`,
      actor: { type: "dashboard", id: "dashboard" },
      afterSummary: this.agentProfileAuditSummary(created),
    });
    return {
      success: true,
      message: "Agent profile created",
      item: created,
    };
  }

  @Put("agent-profiles/:id")
  @RequireDashboardRole("operator")
  @ApiTags("Agent Profiles")
  @ApiOperation({ summary: "Update a local Agent Gateway profile" })
  @ApiParam({ name: "id", example: "profile_01h..." })
  @ApiBody({ type: UpdateAgentProfileDto })
  @ApiOkResponse({ type: AgentProfileMutationResponseDto })
  async updateAgentProfile(
    @Param("id") id: string,
    @Body() body: UpdateAgentProfileDto,
  ) {
    const before = (await this.agentProfiles.list()).find(
      (profile) => profile.id === id,
    );
    const updated = await this.agentProfiles.update(id, body);
    await this.configAudit.recordManagementEvent({
      action: "agent_profile.update",
      target: `agent_profile:${id}`,
      actor: { type: "dashboard", id: "dashboard" },
      beforeSummary: before ? this.agentProfileAuditSummary(before) : undefined,
      afterSummary: this.agentProfileAuditSummary(updated),
      metadata: { fields: Object.keys(body || {}) },
    });
    return {
      success: true,
      message: "Agent profile updated",
      item: updated,
    };
  }

  @Delete("agent-profiles/:id")
  @RequireDashboardRole("admin")
  @ApiTags("Agent Profiles")
  @ApiOperation({ summary: "Delete a local Agent Gateway profile" })
  @ApiParam({ name: "id", example: "profile_01h..." })
  @ApiOkResponse({ type: ActionResponseDto })
  async deleteAgentProfile(@Param("id") id: string) {
    const before = (await this.agentProfiles.list()).find(
      (profile) => profile.id === id,
    );
    await this.agentProfiles.remove(id);
    await this.configAudit.recordManagementEvent({
      action: "agent_profile.delete",
      target: `agent_profile:${id}`,
      actor: { type: "dashboard", id: "dashboard" },
      beforeSummary: before ? this.agentProfileAuditSummary(before) : undefined,
    });
    return { success: true, message: "Agent profile deleted" };
  }

  @Post("agent-profiles/:id/render")
  @RequireDashboardRole("operator")
  @ApiTags("Agent Profiles")
  @ApiOperation({
    summary:
      "Render redacted connector configuration for an Agent Gateway profile",
  })
  @ApiParam({ name: "id", example: "profile_01h..." })
  @ApiBody({ type: RenderAgentProfileDto })
  @ApiOkResponse({ type: AgentProfileRenderResponseDto })
  async renderAgentProfile(
    @Param("id") id: string,
    @Body() body: RenderAgentProfileDto,
  ) {
    const rendered = await this.agentProfiles.render(id, body || {});
    await this.configAudit.recordManagementEvent({
      action: "agent_profile.render",
      target: `agent_profile:${id}`,
      actor: { type: "dashboard", id: "dashboard" },
      afterSummary: {
        id: rendered.profile_id,
        name: rendered.profile_name,
        connector: rendered.connector,
        smart_model_id: rendered.smart_model_id,
        secrets_redacted: true,
      },
    });
    return {
      success: true,
      message: "Agent profile rendered",
      item: rendered,
    };
  }

  private apiKeyAuditSummary(key: {
    id: string;
    name: string;
    status: string;
    key_prefix: string;
    namespace_id: string | null;
    allow_auto: boolean;
    allow_direct: boolean;
    allowed_nodes: string[];
    allowed_models: string[];
    allowed_endpoints: string[];
    allowed_modalities: string[];
    daily_token_limit: number | null;
    daily_cost_limit: number | null;
    rate_limit_per_minute: number | null;
    team_id?: string | null;
    team_name?: string | null;
  }) {
    return {
      id: key.id,
      name: key.name,
      status: key.status,
      key_prefix: key.key_prefix,
      namespace_id: key.namespace_id,
      team_id: key.team_id || null,
      team_name: key.team_name || null,
      allow_auto: key.allow_auto,
      allow_direct: key.allow_direct,
      allowed_nodes: key.allowed_nodes,
      allowed_models: key.allowed_models,
      allowed_endpoints: key.allowed_endpoints,
      allowed_modalities: key.allowed_modalities,
      budget: {
        daily_token_limit: key.daily_token_limit,
        daily_cost_limit: key.daily_cost_limit,
      },
      rate_limit_per_minute: key.rate_limit_per_minute,
      secret: "redacted",
    };
  }

  private agentProfileAuditSummary(profile: {
    id: string;
    name: string;
    connector: string;
    status: string;
    api_key_id: string | null;
    namespace_id: string | null;
    default_model: string;
    smart_model_id: string;
    base_url_mode: string;
    mcp_server_ids: string[];
  }) {
    return {
      id: profile.id,
      name: profile.name,
      connector: profile.connector,
      status: profile.status,
      api_key_id: profile.api_key_id,
      namespace_id: profile.namespace_id,
      default_model: profile.default_model,
      smart_model_id: profile.smart_model_id,
      base_url_mode: profile.base_url_mode,
      mcp_server_count: profile.mcp_server_ids.length,
      mode: "local_only",
      secret: "redacted",
    };
  }

  private teamAuditSummary(team: {
    id: string;
    name: string;
    status: string;
    namespace_id: string | null;
    allowed_nodes: string[];
    allowed_models: string[];
    allowed_endpoints: string[];
    allowed_modalities: string[];
    daily_token_limit: number | null;
    daily_cost_limit: number | null;
    rate_limit_per_minute: number | null;
  }) {
    return {
      id: team.id,
      name: team.name,
      status: team.status,
      namespace_id: team.namespace_id,
      allowed_nodes: team.allowed_nodes,
      allowed_models: team.allowed_models,
      allowed_endpoints: team.allowed_endpoints,
      allowed_modalities: team.allowed_modalities,
      budget: {
        daily_token_limit: team.daily_token_limit,
        daily_cost_limit: team.daily_cost_limit,
      },
      rate_limit_per_minute: team.rate_limit_per_minute,
      mode: "local_only",
      enterprise: {
        sso: false,
        scim: false,
        workspace: false,
      },
      secret: "not_applicable",
    };
  }

  private async namespaceSummary(id: string) {
    const namespace = this.config.getNamespace(id);
    if (!namespace) return null;
    const budget = await this.budgetService.getStatus(null, null, namespace.id);
    return {
      ...this.namespaceAuditSummary(namespace),
      rate_limit_per_minute: namespace.rate_limit?.requests_per_minute || null,
      budget_status: budget.map((item) => this.serializeBudgetStatus(item)),
      bindings: await this.namespaceBindings(namespace.id),
    };
  }

  private namespaceAuditSummary(namespace: NamespaceConfig) {
    return {
      id: namespace.id,
      name: namespace.name || namespace.id,
      allowed_nodes: namespace.allowed_nodes || [],
      allowed_models: namespace.allowed_models || [],
      budget: namespace.budget || null,
      rate_limit: namespace.rate_limit || null,
      mode: "config_backed",
      workspace_scope: "local_policy_only",
      secret: "not_applicable",
    };
  }

  private namespaceMutationMetadata(namespace: NamespaceConfig) {
    return {
      allowed_nodes_count: namespace.allowed_nodes?.length || 0,
      allowed_models_count: namespace.allowed_models?.length || 0,
      has_budget: Boolean(namespace.budget),
      has_rate_limit: Boolean(namespace.rate_limit?.requests_per_minute),
    };
  }

  private namespaceInput(input: CreateNamespaceDto): NamespaceConfig {
    return {
      id: input.id,
      name: this.emptyStringToUndefined(input.name),
      allowed_nodes: this.cleanStringArray(input.allowed_nodes),
      allowed_models: this.cleanStringArray(input.allowed_models),
      budget: this.namespaceBudgetInput(input.budget),
      rate_limit: this.namespaceRateLimitInput(input.rate_limit),
    };
  }

  private namespaceUpdateInput(
    input: UpdateNamespaceDto,
  ): Partial<Omit<NamespaceConfig, "id">> {
    const updates: Partial<Omit<NamespaceConfig, "id">> = {};
    if (input.name !== undefined)
      updates.name = this.emptyStringToUndefined(input.name);
    if (input.allowed_nodes !== undefined) {
      updates.allowed_nodes = this.cleanStringArray(input.allowed_nodes);
    }
    if (input.allowed_models !== undefined) {
      updates.allowed_models = this.cleanStringArray(input.allowed_models);
    }
    if (input.budget !== undefined)
      updates.budget = this.namespaceBudgetInput(input.budget);
    if (input.rate_limit !== undefined)
      updates.rate_limit = this.namespaceRateLimitInput(input.rate_limit);
    return updates;
  }

  private namespaceBudgetInput(
    input: CreateNamespaceDto["budget"] | UpdateNamespaceDto["budget"],
  ): NamespaceConfig["budget"] | undefined {
    if (!input) return undefined;
    const budget: NonNullable<NamespaceConfig["budget"]> = {};
    if (
      input.daily_token_limit !== undefined &&
      input.daily_token_limit !== null
    ) {
      budget.daily_token_limit = Number(input.daily_token_limit);
    }
    if (
      input.daily_cost_limit !== undefined &&
      input.daily_cost_limit !== null
    ) {
      budget.daily_cost_limit = Number(input.daily_cost_limit);
    }
    if (input.alert_threshold !== undefined && input.alert_threshold !== null) {
      budget.alert_threshold = Number(input.alert_threshold);
    }
    return Object.keys(budget).length > 0 ? budget : undefined;
  }

  private namespaceRateLimitInput(
    input: CreateNamespaceDto["rate_limit"] | UpdateNamespaceDto["rate_limit"],
  ): NamespaceConfig["rate_limit"] | undefined {
    if (
      !input ||
      input.requests_per_minute === undefined ||
      input.requests_per_minute === null
    ) {
      return undefined;
    }
    return { requests_per_minute: Number(input.requests_per_minute) };
  }

  private cleanStringArray(values: string[] | undefined): string[] {
    if (!Array.isArray(values)) return [];
    return [
      ...new Set(values.map((value) => String(value).trim()).filter(Boolean)),
    ];
  }

  private emptyStringToUndefined(
    value: string | undefined,
  ): string | undefined {
    const normalized = (value || "").trim();
    return normalized || undefined;
  }

  private async namespaceBindings(namespaceId: string): Promise<{
    api_keys: Array<{
      id: string;
      name: string;
      status: string;
      key_prefix: string;
      team_id: string | null;
      source: "dashboard" | "config";
    }>;
    teams: Array<{
      id: string;
      name: string;
      status: string;
    }>;
    counts: {
      api_keys: number;
      teams: number;
      total: number;
    };
  }> {
    const [apiKeys, teams] = await Promise.all([
      this.gatewayApiKeys.list(),
      this.teams.list(),
    ]);
    const boundTeams = teams
      .filter((team) => team.namespace_id === namespaceId)
      .map((team) => ({
        id: team.id,
        name: team.name,
        status: team.status,
      }));
    const boundTeamIds = new Set(boundTeams.map((team) => team.id));
    const boundDashboardKeys = apiKeys
      .filter(
        (key) =>
          key.namespace_id === namespaceId ||
          (key.team_id && boundTeamIds.has(key.team_id)),
      )
      .map((key) => ({
        id: key.id,
        name: key.name,
        status: key.status,
        key_prefix: key.key_prefix,
        team_id: key.team_id || null,
        source: "dashboard" as const,
      }));
    const boundConfigKeys = (this.config.auth?.api_keys || [])
      .filter((key) => key.namespace_id === namespaceId)
      .map((key) => ({
        id: key.name,
        name: key.name,
        status: "config",
        key_prefix: "config-managed",
        team_id: null,
        source: "config" as const,
      }));
    const boundKeys = [...boundDashboardKeys, ...boundConfigKeys];
    return {
      api_keys: boundKeys,
      teams: boundTeams,
      counts: {
        api_keys: boundKeys.length,
        teams: boundTeams.length,
        total: boundKeys.length + boundTeams.length,
      },
    };
  }

  @Post("budget/:id/reset")
  @RequireDashboardRole("admin")
  @ApiOperation({ summary: "Reset a budget rule counter" })
  @ApiParam({ name: "id", example: 1 })
  @ApiOkResponse({ type: ActionResponseDto })
  async resetBudget(@Param("id", ParseIntPipe) id: number) {
    const before = (await this.budgetService.getStatus()).find(
      (rule) => rule.id === id,
    );
    await this.budgetService.resetRule(id);
    const after = (await this.budgetService.getStatus()).find(
      (rule) => rule.id === id,
    );
    await this.managementAudit.record({
      action: "budget.reset",
      resourceType: "budget_rule",
      resourceId: String(id),
      actor: { type: "dashboard", id: "dashboard" },
      beforeSummary: before ? this.serializeBudgetStatus(before) : null,
      afterSummary: after ? this.serializeBudgetStatus(after) : null,
      source: "dashboard",
    });
    return { success: true, message: `Budget rule ${id} reset` };
  }

  // ══════════════════════════════════════════════════════
  // Cache
  // ══════════════════════════════════════════════════════

  @Get("cache")
  @ApiOperation({ summary: "Get prompt cache stats" })
  @ApiOkResponse({ description: "Prompt cache hit/miss and storage stats." })
  getCacheStats() {
    return this.cacheService.getStats();
  }

  @Post("cache/clear")
  @RequireDashboardRole("operator")
  @ApiOperation({ summary: "Clear prompt cache" })
  @ApiOkResponse({ type: ActionResponseDto })
  async clearCache() {
    const before = this.cacheService.getStats();
    this.cacheService.clear();
    const after = this.cacheService.getStats();
    await this.managementAudit.record({
      action: "cache.clear",
      resourceType: "prompt_cache",
      resourceId: "default",
      actor: { type: "dashboard", id: "dashboard" },
      beforeSummary: before,
      afterSummary: after,
      source: "dashboard",
    });
    return { success: true, message: "Cache cleared" };
  }

  // ══════════════════════════════════════════════════════
  // Telemetry Status
  // ══════════════════════════════════════════════════════

  @Get("telemetry-status")
  @ApiOperation({ summary: "Get local telemetry configuration status" })
  @ApiOkResponse({
    description:
      "Telemetry enabled state and non-secret endpoint configuration.",
  })
  getTelemetryStatus() {
    const fullConfig = this.config.getFullConfig();
    const telemetryCfg = fullConfig.telemetry;
    const enabled = telemetryCfg?.enabled === true;

    return {
      enabled,
      active: enabled, // active = SDK was initialized (enabled at boot time)
      config: enabled
        ? {
            service_name: telemetryCfg?.service_name || "siftgate",
            traces_endpoint:
              telemetryCfg?.traces?.endpoint ||
              "http://localhost:4318/v1/traces",
            sample_rate: telemetryCfg?.traces?.sample_rate ?? 1.0,
            prometheus_port: telemetryCfg?.metrics?.prometheus_port || 9464,
            otlp_metrics_endpoint: telemetryCfg?.metrics?.otlp_endpoint || null,
          }
        : null,
    };
  }

  // ══════════════════════════════════════════════════════
  // Configuration
  // ══════════════════════════════════════════════════════

  @Get("config")
  @ApiOperation({
    summary: "Get sanitized gateway configuration",
    description:
      "Provider API keys are masked, legacy YAML auth keys are omitted, and dashboard password hashes are never returned.",
  })
  @ApiOkResponse({ type: SanitizedConfigResponseDto })
  getConfig() {
    const full = this.config.getFullConfig();

    // Sanitize: mask API keys
    const sanitizedNodes = full.nodes.map((node) => ({
      ...node,
      api_key: node.api_key ? maskSecretForDisplay(node.api_key) : undefined,
      api_key_secret_reference: node.api_key
        ? (this.secretResolver?.isReference(node.api_key) ?? false)
        : false,
      credentials: node.credentials?.map((credential) => ({
        ...credential,
        api_key: maskSecretForDisplay(credential.api_key),
        api_key_secret_reference:
          this.secretResolver?.isReference(credential.api_key) ?? false,
      })),
      headers: this.maskSecretHeaderRecord(node.headers),
    }));

    const sanitizedAuth = {
      api_keys: [],
      managed_in_dashboard: true,
    };

    return {
      server: full.server,
      database: { type: full.database.type },
      auth: sanitizedAuth,
      nodes: sanitizedNodes,
      routing: full.routing,
      routing_status: this.routingService.getRoutingStatus(),
      budget: full.budget,
      namespaces: full.namespaces || [],
      shadow: this.shadowTraffic.getStatus(),
      realtime: this.realtime?.getStatus(
        this.workspaceContext.currentWorkspaceId(),
      ) || {
        enabled: false,
        experimental: true,
        path: "/v1/realtime",
        active_connections: 0,
        max_connections: 0,
        max_connections_per_node: 0,
        idle_timeout_ms: 0,
        upstream_connect_timeout_ms: 0,
        max_session_ms: 0,
        recent: [],
      },
      config_audit: {
        ...this.config.configAudit,
        storage: "local_database",
        secrets: "redacted",
      },
      models_pricing: full.models_pricing,
      diagnostics: this.config.getNodeModelDiagnostics(),
    };
  }

  @Post("config/reload")
  @RequireDashboardRole("operator")
  @ApiOperation({ summary: "Reload gateway.config.yaml from disk" })
  @ApiOkResponse({ type: ActionResponseDto })
  async reloadConfig() {
    const result = this.config.reload({
      source: "dashboard",
      throwOnError: false,
    });
    await this.configAudit.recordReload(result, {
      type: "dashboard",
      id: "dashboard",
    });
    await this.managementAudit.record({
      action: `config.reload.${result.source}`,
      resourceType: "config",
      resourceId: null,
      actor: { type: "dashboard", id: "dashboard" },
      result: result.success ? "success" : "failure",
      beforeSummary: result.previous,
      afterSummary: result.current,
      failureReason: result.error?.message ?? null,
      source: "dashboard",
      metadata: {
        message: result.message,
        rolled_back: result.rolled_back,
        changed: result.changed,
      },
    });
    if (!result.success) {
      throw new HttpException(
        {
          success: false,
          message: result.message,
          error: result.error,
          snapshot: result.current,
          rolled_back: result.rolled_back,
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    this.activeHealth.refreshSchedules();
    return result;
  }

  @Get("config/versions")
  @ApiOperation({ summary: "List local config versions for rollback" })
  @ApiQuery({ name: "limit", required: false, example: 50 })
  @ApiOkResponse({
    description:
      "Config version metadata. Raw rollback YAML is never returned.",
  })
  async getConfigVersions(
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.configAudit.listVersions(limit);
  }

  @Get("config/versions/:id")
  @ApiOperation({ summary: "Get a sanitized config version snapshot" })
  @ApiParam({ name: "id", example: "cfgv_..." })
  @ApiOkResponse({
    description: "Config version metadata plus sanitized config object.",
  })
  async getConfigVersion(@Param("id") id: string) {
    const version = await this.configAudit.getVersion(id);
    if (!version) {
      throw new HttpException(
        { success: false, message: `Config version "${id}" not found` },
        HttpStatus.NOT_FOUND,
      );
    }
    return version;
  }

  @Post("config/versions/:id/rollback")
  @RequireDashboardRole("admin")
  @ApiOperation({
    summary: "Rollback gateway.config.yaml to a stored local version",
  })
  @ApiParam({ name: "id", example: "cfgv_..." })
  @ApiBody({
    schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      example: { reason: "Restore last known good routing config" },
    },
    required: false,
  })
  @ApiOkResponse({ type: ActionResponseDto })
  async rollbackConfigVersion(
    @Param("id") id: string,
    @Body() body: { reason?: string } = {},
  ) {
    try {
      const result = await this.configAudit.rollbackToVersion(id, {
        reason: body?.reason,
        actor: { type: "dashboard", id: "dashboard" },
        source: "dashboard",
      });
      if (!result.success) {
        throw new HttpException(
          { ...result, success: false },
          HttpStatus.BAD_REQUEST,
        );
      }
      this.activeHealth.refreshSchedules();
      return { ...result, success: true };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { success: false, message: (err as Error).message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get("config/audit-events")
  @ApiOperation({ summary: "List local config audit events" })
  @ApiQuery({ name: "limit", required: false, example: 100 })
  @ApiQuery({ name: "action", required: false })
  @ApiQuery({ name: "target", required: false })
  @ApiQuery({ name: "result", required: false, enum: ["success", "failure"] })
  @ApiOkResponse({ description: "Local config audit event metadata." })
  async getConfigAuditEvents(
    @Query("limit", new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query("action") action?: string,
    @Query("target") target?: string,
    @Query("result") result?: "success" | "failure",
  ) {
    return this.configAudit.listEvents({ limit, action, target, result });
  }

  @Get("audit")
  @RequireDashboardRole("viewer")
  @ApiOperation({ summary: "List platform management audit events" })
  @ApiQuery({ name: "limit", required: false, example: 100 })
  @ApiQuery({ name: "action", required: false })
  @ApiQuery({ name: "resource_type", required: false })
  @ApiQuery({ name: "resource_id", required: false })
  @ApiQuery({ name: "actor_id", required: false })
  @ApiQuery({
    name: "result",
    required: false,
    enum: ["success", "failure", "denied"],
  })
  @ApiOkResponse({
    type: ManagementAuditEventsResponseDto,
    description:
      "Workspace-scoped platform management audit events. Summaries are redacted and metadata-only.",
  })
  async getManagementAuditEvents(
    @Query("limit", new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query("action") action?: string,
    @Query("resource_type") resourceType?: string,
    @Query("resource_id") resourceId?: string,
    @Query("actor_id") actorId?: string,
    @Query("result") result?: ManagementAuditResult,
  ) {
    return this.managementAudit.list({
      limit,
      action,
      resourceType,
      resourceId,
      actorId,
      result,
    });
  }

  // ══════════════════════════════════════════════════════
  // Catalog & Capabilities
  // ══════════════════════════════════════════════════════

  /** Get all capability definitions */
  @Get("capabilities")
  @ApiOperation({ summary: "List known capability definitions" })
  @ApiOkResponse({
    description:
      "Capability registry used by tier recommendation and routing suggestions.",
  })
  getCapabilities() {
    return { capabilities: this.capabilityService.getRegistry() };
  }

  /** Recommend tier suitability given a set of capabilities */
  @Post("capabilities/recommend-tiers")
  @RequireDashboardRole("operator")
  @ApiOperation({ summary: "Recommend tiers for a capability set" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        capabilities: { type: "array", items: { type: "string" } },
      },
      example: { capabilities: ["coding", "reasoning"] },
    },
  })
  @ApiOkResponse({ description: "Tier recommendations by capability." })
  recommendTiers(@Body() body: { capabilities: string[] }) {
    const capabilities = body.capabilities || [];
    return {
      recommendations: this.capabilityService.recommendTiers(capabilities),
    };
  }

  @Get("catalog/providers")
  @ApiOperation({
    summary: "List merged built-in and local provider catalog entries",
  })
  @ApiQuery({ name: "show_legacy", required: false })
  @ApiOkResponse({
    description: "Provider catalog entries with overridden markers.",
  })
  getCatalogProviders(@Query("show_legacy") showLegacyQuery?: string) {
    const loaded = this.catalog.load();
    const showLegacy = parseBooleanQuery(showLegacyQuery);
    const context = buildDashboardCatalogContext(loaded.internal);
    const syncStatus = buildCatalogSyncStatus({
      config: this.config.getFullConfig().catalog,
      catalog: loaded.catalog,
      internal: loaded.internal,
      cachePath: loaded.syncCachePath,
      cacheFound: loaded.syncCacheFound,
      overridePath: loaded.overridePath,
      overrideFound: loaded.overrideFound,
      issues: loaded.issues,
    });
    return {
      source: "builtin_static",
      auto_update: syncStatus.scheduled,
      provider_visibility: summarizeCatalogProviderVisibility(loaded.catalog),
      refresh_sources: getCatalogRefreshSources(),
      sync_status: syncStatus,
      providers: loaded.catalog.providers
        .filter((provider) => includeDashboardProvider(provider, showLegacy))
        .map((provider) => toDashboardCatalogProvider(provider, context)),
      compatibility_profiles: listCompatibilityProfiles(),
      override_file: loaded.overridePath,
      override_found: loaded.overrideFound,
      sync_cache_file: loaded.syncCachePath,
      sync_cache_found: loaded.syncCacheFound,
      issues: loaded.issues,
    };
  }

  @Get("catalog/models")
  @ApiOperation({
    summary: "List merged built-in and local model catalog entries",
  })
  @ApiQuery({ name: "provider", required: false })
  @ApiQuery({ name: "modality", required: false })
  @ApiQuery({ name: "endpoint", required: false })
  @ApiQuery({ name: "show_legacy", required: false })
  @ApiOkResponse({
    description: "Flattened model catalog entries with overridden markers.",
  })
  getCatalogModels(
    @Query("provider") provider?: string,
    @Query("modality") modality?: string,
    @Query("endpoint") endpoint?: string,
    @Query("show_legacy") showLegacyQuery?: string,
  ) {
    const loaded = this.catalog.load();
    const showLegacy = parseBooleanQuery(showLegacyQuery);
    const context = buildDashboardCatalogContext(loaded.internal);
    const syncStatus = buildCatalogSyncStatus({
      config: this.config.getFullConfig().catalog,
      catalog: loaded.catalog,
      internal: loaded.internal,
      cachePath: loaded.syncCachePath,
      cacheFound: loaded.syncCacheFound,
      overridePath: loaded.overridePath,
      overrideFound: loaded.overrideFound,
      issues: loaded.issues,
    });
    let models = loaded.catalog.providers
      .filter((entry) => includeDashboardProvider(entry, showLegacy))
      .flatMap((entry) =>
        entry.models.map((model) =>
          toDashboardCatalogModel(model, entry, context),
        ),
      );
    if (provider)
      models = models.filter((model) => model.provider === provider);
    if (modality) {
      models = models.filter((model) =>
        (model.modalities as string[]).includes(modality),
      );
    }
    if (endpoint) {
      models = models.filter((model) => model.endpoints.includes(endpoint));
    }
    return {
      source: "builtin_static",
      auto_update: syncStatus.scheduled,
      refresh_sources: getCatalogRefreshSources(),
      sync_status: syncStatus,
      models,
      override_file: loaded.overridePath,
      override_found: loaded.overrideFound,
      sync_cache_file: loaded.syncCachePath,
      sync_cache_found: loaded.syncCacheFound,
      issues: loaded.issues,
    };
  }

  @Post("provider-extensibility/templates/custom/preview")
  @RequireDashboardRole("operator")
  @ApiOperation({
    summary:
      "Preview a custom provider node and catalog manifest without saving secrets",
  })
  @ApiBody({ type: CustomProviderTemplatePreviewDto })
  @ApiOkResponse({
    description:
      "Sanitized custom provider node and catalog manifest preview. Provider API keys, raw headers, prompts, responses, media bytes, and tool payloads are never returned.",
  })
  previewCustomProviderTemplate(@Body() dto: CustomProviderTemplatePreviewDto) {
    return this.providerExtensibility.previewCustomProviderTemplate(dto);
  }

  @Post("provider-extensibility/sdk/generate")
  @RequireDashboardRole("operator")
  @ApiOperation({
    summary: "Generate a beta provider adapter skeleton for manual review",
  })
  @ApiBody({ type: ProviderSdkGeneratorDto })
  @ApiOkResponse({
    description:
      "Generated provider adapter files and tests. Output is beta, metadata-only, and requires manual review before registry submission.",
  })
  generateProviderSdk(@Body() dto: ProviderSdkGeneratorDto) {
    return this.providerExtensibility.generateProviderSdk(dto);
  }

  @Get("provider-health")
  @RequireDashboardRole("viewer")
  @ApiOperation({
    summary:
      "Get workspace-scoped provider health, latency, errors, and pricing warnings",
  })
  @ApiQuery({ name: "period", required: false, example: "24h" })
  @ApiOkResponse({
    description:
      "Provider health summary derived from probes, circuits, and call-log metadata without prompts, responses, raw headers, provider keys, media bytes, or tool payloads.",
  })
  getProviderHealth(@Query("period") period: string = "24h") {
    return this.providerExtensibility.providerHealthSummary(period);
  }

  /** Recommend full routing config based on all nodes' capabilities */
  @Post("routing/recommend")
  @RequireDashboardRole("operator")
  @ApiOperation({ summary: "Recommend routing config from node capabilities" })
  @ApiOkResponse({ description: "Suggested routing configuration." })
  recommendRouting() {
    return { recommendations: this.capabilityService.recommendRouting() };
  }

  /** Read-only adaptive routing recommendations from local sliding-window metrics */
  @Get("routing/recommendations")
  getAdaptiveRoutingRecommendations(
    @Query("window_hours", new DefaultValuePipe(24), ParseIntPipe)
    windowHours: number,
    @Query("sample_limit", new DefaultValuePipe(1000), ParseIntPipe)
    sampleLimit: number,
  ) {
    return this.routingRecommendations.getRecommendations({
      windowHours,
      sampleLimit,
    });
  }

  /** Update routing configuration (tiers, scoring, domain preferences) */
  @Put("routing")
  @RequireDashboardRole("operator")
  @ApiOperation({
    summary: "Update routing tiers, scoring thresholds, and domain preferences",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        tiers: { type: "object" },
        scoring: { type: "object" },
        domain_preferences: { type: "object" },
      },
      example: {
        tiers: {
          standard: {
            primary: { node: "openai", model: "gpt-4o" },
            fallbacks: [
              { node: "anthropic", model: "claude-sonnet-4-20250514" },
            ],
          },
        },
      },
    },
  })
  @ApiOkResponse({ type: ActionResponseDto })
  async updateRouting(
    @Body()
    body: {
      tiers?: Record<
        string,
        {
          primary?: { node: string; model: string };
          fallbacks?: { node: string; model: string }[];
          strategy?: "weighted" | "round_robin" | "least_latency" | "random";
          targets?: {
            node: string;
            model: string;
            weight?: number;
            name?: string;
          }[];
          split?: {
            node: string;
            model: string;
            weight: number;
            name?: string;
          }[];
        }
      >;
      scoring?: {
        simple_max: number;
        standard_max: number;
        complex_max: number;
      };
      domain_preferences?: Record<string, string[]>;
    },
  ) {
    try {
      await this.configAudit.trackChange(
        {
          action: "config.routing.update",
          target: "routing",
          source: "dashboard",
          actor: { type: "dashboard", id: "dashboard" },
          metadata: { fields: Object.keys(body || {}) },
        },
        () => this.config.updateRouting(body),
      );
      return { success: true, message: "Routing configuration updated" };
    } catch (err) {
      throw new HttpException(
        { success: false, message: (err as Error).message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  // ══════════════════════════════════════════════════════
  // Nodes
  // ══════════════════════════════════════════════════════

  @Get("nodes")
  @ApiOperation({
    summary: "List configured nodes, capabilities, and circuit status",
  })
  @ApiOkResponse({
    description: "Node status list with no provider API key values.",
  })
  async getNodes() {
    const compatibility = await this.providerCompatibility.matrixForNodes(
      this.config.nodes,
    );
    const nodes = this.config.nodes.map((node) => {
      const cbStatus = this.circuitBreaker.getNodeStatus(node.id);
      const modelStatuses = this.circuitBreaker.getModelStatuses(node.id);
      const concurrency = this.concurrencyLimiter.getNodeStats(node);
      const activeProbe = this.activeHealth.getNodeStatus(node.id);
      const modelIds = Array.from(
        new Set([
          ...node.models,
          ...(node.embedding_models || []),
          ...(node.rerank_models || []),
          ...(node.image_models || []),
          ...(node.audio_models || []),
          ...(node.video_models || []),
          ...(node.realtime_models || []),
        ]),
      );
      const modelCapabilities = Object.fromEntries(
        modelIds.map((model) => [
          model,
          this.capabilityService.resolveModelRoutingCapabilities(
            node.id,
            model,
          ),
        ]),
      );
      const endpoints = {
        default: node.endpoint,
        ...(node.embeddings_endpoint
          ? { embeddings: node.embeddings_endpoint }
          : {}),
        ...(node.rerank_endpoint ? { rerank: node.rerank_endpoint } : {}),
        ...(node.images_generations_endpoint
          ? { image_generations: node.images_generations_endpoint }
          : {}),
        ...(node.images_edits_endpoint
          ? { image_edits: node.images_edits_endpoint }
          : {}),
        ...(node.images_variations_endpoint
          ? { image_variations: node.images_variations_endpoint }
          : {}),
        ...(node.audio_transcriptions_endpoint
          ? { audio_transcriptions: node.audio_transcriptions_endpoint }
          : {}),
        ...(node.audio_translations_endpoint
          ? { audio_translations: node.audio_translations_endpoint }
          : {}),
        ...(node.audio_speech_endpoint
          ? { audio_speech: node.audio_speech_endpoint }
          : {}),
        ...(node.video_generations_endpoint
          ? { video_generations: node.video_generations_endpoint }
          : {}),
        ...(node.video_status_endpoint
          ? { video_status: node.video_status_endpoint }
          : {}),
        ...(node.batch_endpoint ? { batch: node.batch_endpoint } : {}),
        ...(node.batch_status_endpoint
          ? { batch_status: node.batch_status_endpoint }
          : {}),
        ...(node.batch_cancel_endpoint
          ? { batch_cancel: node.batch_cancel_endpoint }
          : {}),
        ...(node.batch_result_endpoint
          ? { batch_result: node.batch_result_endpoint }
          : {}),
        ...(node.realtime_endpoint ? { realtime: node.realtime_endpoint } : {}),
        ...(node.images_generations_endpoint
          ? { image_generation: node.images_generations_endpoint }
          : {}),
        ...(node.images_edits_endpoint
          ? { image_edit: node.images_edits_endpoint }
          : {}),
        ...(node.images_variations_endpoint
          ? { image_variation: node.images_variations_endpoint }
          : {}),
        ...(node.audio_transcriptions_endpoint
          ? { audio_transcription: node.audio_transcriptions_endpoint }
          : {}),
        ...(node.audio_translations_endpoint
          ? { audio_translation: node.audio_translations_endpoint }
          : {}),
        ...(node.audio_speech_endpoint
          ? { audio_speech: node.audio_speech_endpoint }
          : {}),
        ...(node.images_generations_endpoint
          ? { images: node.images_generations_endpoint }
          : {}),
        ...(node.audio_transcriptions_endpoint
          ? { audio: node.audio_transcriptions_endpoint }
          : {}),
        ...(node.video_endpoint || node.video_generations_endpoint
          ? { video: node.video_endpoint || node.video_generations_endpoint }
          : {}),
        ...(node.video_endpoint ? { video_endpoint: node.video_endpoint } : {}),
        ...(node.video_content_endpoint
          ? { video_content: node.video_content_endpoint }
          : {}),
        ...(node.video_cancel_endpoint
          ? { video_cancel: node.video_cancel_endpoint }
          : {}),
        ...(node.realtime_endpoint ? { realtime: node.realtime_endpoint } : {}),
        ...(node.endpoints || {}),
      };

      // Build per-model circuit info
      const modelCircuits: Record<
        string,
        {
          state: string;
          consecutiveFailures: number;
          lastFailureAt: string | null;
        }
      > = {};
      for (const [model, ms] of Object.entries(modelStatuses)) {
        modelCircuits[model] = {
          state: ms.state,
          consecutiveFailures: ms.consecutiveFailures,
          lastFailureAt: ms.lastFailureAt
            ? new Date(ms.lastFailureAt).toISOString()
            : null,
        };
      }

      return {
        id: node.id,
        name: node.name,
        protocol: node.protocol,
        base_url: node.base_url,
        endpoint: node.endpoint,
        timeout_ms: node.timeout_ms,
        max_concurrency: node.max_concurrency ?? null,
        queue_timeout_ms: node.queue_timeout_ms ?? null,
        queue_policy: node.queue_policy ?? null,
        health_check: node.health_check ?? null,
        auth_type: node.auth_type || null,
        auth_header_name:
          node.auth_type === "custom-header"
            ? node.auth_header_name || null
            : null,
        auth_header_prefix:
          node.auth_type === "custom-header"
            ? node.auth_header_prefix || null
            : null,
        credentials: (node.credentials || []).map((credential) => ({
          id: credential.id,
          enabled: credential.enabled !== false,
          weight: credential.weight ?? 1,
          api_key: maskSecretForDisplay(credential.api_key),
          api_key_secret_reference:
            this.secretResolver?.isReference(credential.api_key) ?? false,
        })),
        credential_pool: this.credentialPool?.getNodeStatus(node) || {
          enabled: false,
          strategy: node.credential_pool?.strategy || "least_in_flight",
          sticky_by: node.credential_pool?.sticky_by || "agent_session",
          cooldown_ms: node.credential_pool?.cooldown_ms ?? 60000,
          max_failures: node.credential_pool?.max_failures ?? 3,
          retry_on_status: node.credential_pool?.retry_on_status || [
            429, 500, 502, 503, 504,
          ],
          credentials: [],
        },
        endpoints,
        models: node.models,
        embedding_models: node.embedding_models || [],
        embeddings_endpoint: node.embeddings_endpoint || null,
        rerank_models: node.rerank_models || [],
        image_models: node.image_models || [],
        images_generations_endpoint: node.images_generations_endpoint || null,
        images_edits_endpoint: node.images_edits_endpoint || null,
        images_variations_endpoint: node.images_variations_endpoint || null,
        audio_models: node.audio_models || [],
        audio_transcriptions_endpoint:
          node.audio_transcriptions_endpoint || null,
        audio_translations_endpoint: node.audio_translations_endpoint || null,
        audio_speech_endpoint: node.audio_speech_endpoint || null,
        video_models: node.video_models || [],
        video_generations_endpoint: node.video_generations_endpoint || null,
        video_endpoint: node.video_endpoint || null,
        video_status_endpoint: node.video_status_endpoint || null,
        video_result_profile: node.video_result_profile ?? "generic-v1",
        video_content_endpoint: node.video_content_endpoint || null,
        video_cancel_endpoint: node.video_cancel_endpoint || null,
        batch_endpoint: node.batch_endpoint || null,
        batch_status_endpoint: node.batch_status_endpoint || null,
        batch_cancel_endpoint: node.batch_cancel_endpoint || null,
        batch_result_endpoint: node.batch_result_endpoint || null,
        compatibility_profile: Array.isArray(node.compatibility_profile)
          ? node.compatibility_profile
          : node.compatibility_profile
            ? [node.compatibility_profile]
            : [],
        resolved_compatibility_profiles: resolveNodeCompatibilityProfileIds(
          node,
          this.config.getMergedCatalog(),
        ),
        capabilities: this.capabilityService.getNodeCapabilities(node.id),
        modalities: this.capabilityService.resolveNodeModalities(node.id),
        model_capabilities: modelCapabilities,
        configured_pricing_models: Object.entries(node.model_capabilities ?? {})
          .filter(([, capability]) => capability.pricing !== undefined)
          .map(([model]) => model),
        tags: node.tags || [],
        aliases: node.model_aliases || {},
        upstream_model_aliases: node.upstream_model_aliases || {},
        request_compatibility: node.request_compatibility || {},
        model_prefixes: node.model_prefixes || [],
        circuit: {
          state: cbStatus.state,
          consecutiveFailures: cbStatus.consecutiveFailures,
          lastFailureAt: cbStatus.lastFailureAt
            ? new Date(cbStatus.lastFailureAt).toISOString()
            : null,
        },
        modelCircuits,
        concurrency,
        active_probe: activeProbe,
        realtime: this.realtime?.getNodeStatus(
          node.id,
          this.workspaceContext.currentWorkspaceId(),
        ) || {
          enabled: false,
          experimental: true,
          supported: false,
          endpoint: null,
          models: [],
          active_connections: 0,
          max_connections_per_node: 0,
          last_connected_at: null,
          last_closed_at: null,
          last_error: null,
        },
        compatibility_matrix: compatibility[node.id] || [],
        healthy:
          cbStatus.state !== CircuitState.OPEN &&
          activeProbe.status !== "unhealthy",
      };
    });

    return {
      nodes,
      diagnostics: [
        ...this.config.getNodeModelDiagnostics(),
        ...this.providerCompatibility.compatibilityDiagnostics(compatibility),
      ],
    };
  }

  // ── Node Connectivity Test ─────────────────────────────

  /** Test a new node before saving (provide all params) */
  @Post("nodes/test")
  @RequireDashboardRole("operator")
  @ApiOperation({ summary: "Test a node configuration before saving it" })
  @ApiBody({ type: TestNodeDto })
  @ApiOkResponse({
    description:
      "Connectivity result. Provider API key is accepted as write-only input and is not returned.",
  })
  async testNodeConnectivity(@Body() dto: TestNodeDto) {
    return this.runConnectivityTest({
      protocol: dto.protocol,
      base_url: dto.base_url,
      endpoint: dto.endpoint,
      api_key: dto.api_key,
      model: dto.model,
      auth_type: dto.auth_type,
      auth_header_name: dto.auth_header_name,
      auth_header_prefix: dto.auth_header_prefix,
      headers: dto.headers,
    });
  }

  /** Test an existing node using its saved config (no need to re-enter API key) */
  @Post("nodes/:id/test")
  @RequireDashboardRole("operator")
  @ApiOperation({ summary: "Test an existing saved node" })
  @ApiParam({ name: "id", example: "openai" })
  @ApiOkResponse({
    description: "Connectivity result using the saved provider key.",
  })
  async testExistingNode(
    @Param("id") nodeId: string,
    @Body() dto?: Pick<TestNodeDto, "capabilities" | "confirm_expensive">,
  ) {
    const node = this.config.getNode(nodeId);
    if (!node) {
      throw new HttpException(
        { success: false, message: `Node "${nodeId}" not found` },
        HttpStatus.NOT_FOUND,
      );
    }
    return this.providerCompatibility.runNodeMatrix(node, {
      capabilities: dto?.capabilities as
        | ProviderCompatibilityCapability[]
        | undefined,
      confirm_expensive: dto?.confirm_expensive,
    });
  }

  @Post("nodes/:id/reset")
  @RequireDashboardRole("operator")
  @ApiOperation({ summary: "Reset node or node:model circuit breaker state" })
  @ApiParam({ name: "id", example: "openai" })
  @ApiQuery({ name: "model", required: false, example: "gpt-4o" })
  @ApiOkResponse({ type: ActionResponseDto })
  async resetNodeCircuit(
    @Param("id") nodeId: string,
    @Query("model") model?: string,
  ) {
    if (model) {
      this.circuitBreaker.reset(nodeId, model);
      await this.managementAudit.record({
        action: "circuit_breaker.reset",
        resourceType: "node_model_circuit",
        resourceId: `${nodeId}:${model}`,
        actor: { type: "dashboard", id: "dashboard" },
        afterSummary: { node_id: nodeId, model, reset: true },
        source: "dashboard",
      });
      return {
        success: true,
        message: `Circuit breaker reset for "${nodeId}:${model}"`,
      };
    }
    this.circuitBreaker.reset(nodeId);
    await this.managementAudit.record({
      action: "circuit_breaker.reset",
      resourceType: "node_circuit",
      resourceId: nodeId,
      actor: { type: "dashboard", id: "dashboard" },
      afterSummary: { node_id: nodeId, reset: true },
      source: "dashboard",
    });
    return {
      success: true,
      message: `Circuit breaker reset for node "${nodeId}"`,
    };
  }

  // ── Private: shared connectivity test logic ────────────

  private async runConnectivityTest(params: {
    protocol: string;
    base_url: string;
    endpoint: string;
    api_key: string;
    model: string;
    auth_type?: string;
    auth_header_name?: string;
    auth_header_prefix?: string;
    headers?: Record<string, string>;
  }) {
    const {
      protocol,
      base_url,
      endpoint,
      api_key,
      model,
      auth_type,
      auth_header_name,
      auth_header_prefix,
      headers: extraHeaders,
    } = params;
    const resolvedEndpoint =
      protocol === "gemini"
        ? endpoint
            .replace(":model", encodeURIComponent(model))
            .replace("{model}", encodeURIComponent(model))
        : endpoint;
    const url = `${base_url.replace(/\/+$/, "")}${resolvedEndpoint}`;

    // Build auth headers
    const resolvedAuthType =
      auth_type ||
      (protocol === "messages" || protocol === "gemini"
        ? "x-api-key"
        : "bearer");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    let resolvedApiKey: string;
    let resolvedExtraHeaders: Record<string, string>;
    try {
      resolvedApiKey = this.secretResolver
        ? await this.secretResolver.resolveString(api_key, {
            location: "dashboard.nodes.test.api_key",
          })
        : api_key;
      resolvedExtraHeaders = this.secretResolver
        ? await this.secretResolver.resolveRecord(extraHeaders, {
            optional: true,
            location: "dashboard.nodes.test.headers",
          })
        : { ...(extraHeaders || {}) };
    } catch (err) {
      return {
        success: false,
        status: 0,
        latency_ms: 0,
        message: `Secret reference could not be resolved: ${(err as Error).message}`,
      };
    }

    if (resolvedAuthType === "custom-header") {
      if (!auth_header_name?.trim()) {
        return {
          success: false,
          status: 0,
          latency_ms: 0,
          message: "Custom auth header name is required.",
        };
      }
      headers[auth_header_name.trim()] = auth_header_prefix?.trim()
        ? `${auth_header_prefix.trim()} ${resolvedApiKey}`
        : resolvedApiKey;
    } else if (resolvedAuthType === "x-api-key") {
      if (usesGoogleApiKeyHeader(protocol, base_url)) {
        headers["x-goog-api-key"] = resolvedApiKey;
      } else {
        headers["x-api-key"] = resolvedApiKey;
        headers["anthropic-version"] = "2023-06-01";
      }
    } else {
      headers["Authorization"] = `Bearer ${resolvedApiKey}`;
    }

    Object.assign(headers, resolvedExtraHeaders);

    // Build minimal request body per protocol (small max_tokens to minimize cost)
    let body: Record<string, unknown>;
    if (protocol === "messages") {
      body = {
        model,
        stream: false,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      };
    } else if (protocol === "responses") {
      body = {
        model,
        stream: false,
        max_output_tokens: 16,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hi" }],
          },
        ],
      };
    } else if (protocol === "gemini") {
      body = {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 16 },
      };
    } else {
      // chat_completions
      body = {
        model,
        stream: false,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      };
    }

    const startTime = Date.now();
    const timeoutMs = 15_000;
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
        {
          timeoutMs,
          timeoutMessage: `Dashboard provider connectivity test timed out after ${timeoutMs}ms.`,
        },
      );

      const latencyMs = Date.now() - startTime;
      const responseText = await response.text().catch(() => "");

      if (response.ok) {
        return {
          success: true,
          status: response.status,
          latency_ms: latencyMs,
          message: `Connected successfully (${latencyMs}ms)`,
        };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          status: response.status,
          latency_ms: latencyMs,
          message: `Authentication failed (${response.status}). Check your API key.`,
        };
      }

      if (response.status === 404) {
        return {
          success: false,
          status: response.status,
          latency_ms: latencyMs,
          message: `Endpoint not found (404). Check base URL and endpoint path.`,
        };
      }

      if (response.status === 400 || response.status === 422) {
        const lower = responseText.toLowerCase();
        if (
          lower.includes("model") &&
          (lower.includes("not found") ||
            lower.includes("not exist") ||
            lower.includes("invalid"))
        ) {
          return {
            success: false,
            status: response.status,
            latency_ms: latencyMs,
            message: `Connected, but model "${model}" was not recognized by the provider.`,
          };
        }
        return {
          success: true,
          status: response.status,
          latency_ms: latencyMs,
          message: `Connected (${latencyMs}ms). Provider returned ${response.status} — may need config tuning.`,
        };
      }

      if (response.status === 429) {
        return {
          success: true,
          status: response.status,
          latency_ms: latencyMs,
          message: `Connected (${latencyMs}ms). Rate limited — API key is valid but quota exceeded.`,
        };
      }

      return {
        success: false,
        status: response.status,
        latency_ms: latencyMs,
        message: `Provider returned HTTP ${response.status}: ${responseText.substring(0, 200)}`,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const fullMsg = fetchErrorMessage(err).toLowerCase();

      if (fullMsg.includes("abort") || fullMsg.includes("timeout")) {
        return {
          success: false,
          status: 0,
          latency_ms: latencyMs,
          message: `Connection timed out after 15s. Check the URL is reachable.`,
        };
      }
      if (fullMsg.includes("enotfound") || fullMsg.includes("getaddrinfo")) {
        return {
          success: false,
          status: 0,
          latency_ms: latencyMs,
          message: `DNS resolution failed. The hostname could not be found.`,
        };
      }
      if (fullMsg.includes("econnrefused")) {
        return {
          success: false,
          status: 0,
          latency_ms: latencyMs,
          message: `Connection refused. The server is not accepting connections.`,
        };
      }
      if (
        fullMsg.includes("ssl") ||
        fullMsg.includes("cert") ||
        fullMsg.includes("tls")
      ) {
        return {
          success: false,
          status: 0,
          latency_ms: latencyMs,
          message: `SSL/TLS error. Check if the URL requires HTTPS or has a valid certificate.`,
        };
      }

      return {
        success: false,
        status: 0,
        latency_ms: latencyMs,
        message: `Connection error: ${redactedFetchErrorMessage(err)}`,
      };
    }
  }

  // ── Node CRUD ──────────────────────────────────────────

  @Post("nodes")
  @RequireDashboardRole("operator")
  @ApiOperation({ summary: "Create a provider node" })
  @ApiBody({ type: CreateNodeDto })
  @ApiOkResponse({ type: ActionResponseDto })
  async createNode(@Body() dto: CreateNodeDto) {
    try {
      await this.configAudit.trackChange(
        {
          action: "config.node.create",
          target: `node:${dto.id}`,
          source: "dashboard",
          actor: { type: "dashboard", id: "dashboard" },
          metadata: {
            protocol: dto.protocol,
            models: dto.models,
            embedding_models: dto.embedding_models,
            rerank_models: dto.rerank_models,
            image_models: dto.image_models,
            audio_models: dto.audio_models,
            video_models: dto.video_models,
            realtime_models: dto.realtime_models,
            compatibility_profile: dto.compatibility_profile,
          },
        },
        () =>
          this.config.addNode({
            id: dto.id,
            name: dto.name,
            protocol: dto.protocol,
            base_url: dto.base_url,
            endpoint: dto.endpoint,
            api_key: dto.api_key,
            credentials: dto.credentials,
            credential_pool: dto.credential_pool,
            models: dto.models,
            embeddings_endpoint: dto.embeddings_endpoint,
            embedding_models: dto.embedding_models,
            rerank_endpoint: dto.rerank_endpoint,
            rerank_models: dto.rerank_models,
            images_generations_endpoint: dto.images_generations_endpoint,
            images_edits_endpoint: dto.images_edits_endpoint,
            images_variations_endpoint: dto.images_variations_endpoint,
            image_models: dto.image_models,
            audio_transcriptions_endpoint: dto.audio_transcriptions_endpoint,
            audio_translations_endpoint: dto.audio_translations_endpoint,
            audio_speech_endpoint: dto.audio_speech_endpoint,
            audio_models: dto.audio_models,
            video_generations_endpoint: dto.video_generations_endpoint,
            video_endpoint: dto.video_endpoint,
            video_status_endpoint: dto.video_status_endpoint,
            video_result_profile: dto.video_result_profile,
            video_content_endpoint: dto.video_content_endpoint,
            video_cancel_endpoint: dto.video_cancel_endpoint,
            batch_endpoint: dto.batch_endpoint,
            batch_status_endpoint: dto.batch_status_endpoint,
            batch_cancel_endpoint: dto.batch_cancel_endpoint,
            batch_result_endpoint: dto.batch_result_endpoint,
            compatibility_profile: dto.compatibility_profile,
            video_models: dto.video_models,
            realtime_models: dto.realtime_models,
            realtime_endpoint: dto.realtime_endpoint,
            timeout_ms: dto.timeout_ms,
            max_concurrency: dto.max_concurrency,
            queue_timeout_ms: dto.queue_timeout_ms,
            queue_policy: dto.queue_policy,
            capabilities: dto.capabilities,
            modalities: dto.modalities as Modality[] | undefined,
            tags: dto.tags,
            model_aliases: dto.model_aliases,
            upstream_model_aliases: dto.upstream_model_aliases,
            request_compatibility: dto.request_compatibility,
            model_prefixes: dto.model_prefixes,
            headers: dto.headers,
            auth_type: dto.auth_type,
            auth_header_name: dto.auth_header_name,
            auth_header_prefix: dto.auth_header_prefix,
            model_capabilities: dto.model_capabilities as any,
            health_check: dto.health_check,
          }),
      );
      this.activeHealth.refreshSchedules();
      return { success: true, message: `Node "${dto.id}" created` };
    } catch (err) {
      throw new HttpException(
        { success: false, message: (err as Error).message },
        HttpStatus.CONFLICT,
      );
    }
  }

  @Put("nodes/:id")
  @RequireDashboardRole("operator")
  @ApiOperation({ summary: "Update a provider node" })
  @ApiParam({ name: "id", example: "openai" })
  @ApiBody({ type: UpdateNodeDto })
  @ApiOkResponse({ type: ActionResponseDto })
  async updateNode(@Param("id") nodeId: string, @Body() dto: UpdateNodeDto) {
    try {
      if (
        dto.model_pricing_updates !== undefined &&
        dto.model_capabilities !== undefined
      )
        throw new HttpException(
          {
            success: false,
            message:
              "Choose a lossless pricing patch or a full capability replacement, not both.",
          },
          HttpStatus.BAD_REQUEST,
        );
      // Keep omitted fields intact. class-transformer may materialize optional
      // DTO properties as undefined, so strip them before merging into config.
      const updates: Partial<typeof dto> = {};
      for (const [key, value] of Object.entries(dto) as [
        keyof UpdateNodeDto,
        unknown,
      ][]) {
        if (value === undefined || value === "") continue;
        (updates as Record<string, unknown>)[key] = value;
      }
      if (Array.isArray(updates.credentials)) {
        const existing = this.config.getNode(nodeId);
        if (!existing) {
          throw new HttpException(
            { success: false, message: "Node not found" },
            HttpStatus.NOT_FOUND,
          );
        }
        updates.credentials = updates.credentials.map((credential) => {
          const current = existing?.credentials?.find(
            (entry) => entry.id === credential.id,
          );
          const apiKey = credential.api_key?.trim() || current?.api_key;
          if (!apiKey?.trim()) {
            throw new HttpException(
              {
                success: false,
                message: "A new credential requires a non-blank api_key.",
              },
              HttpStatus.BAD_REQUEST,
            );
          }
          return { ...credential, api_key: apiKey };
        }) as typeof updates.credentials;
      }
      await this.configAudit.trackChange(
        {
          action: "config.node.update",
          target: `node:${nodeId}`,
          source: "dashboard",
          actor: { type: "dashboard", id: "dashboard" },
          metadata: { fields: Object.keys(updates) },
        },
        () => {
          const { model_pricing_updates: pricingUpdates, ...nodeUpdates } =
            updates;
          if (pricingUpdates !== undefined) {
            try {
              nodeUpdates.model_capabilities = applyNodePricingUpdates(
                this.config.getNode(nodeId)?.model_capabilities,
                pricingUpdates,
              );
            } catch (error) {
              throw new HttpException(
                { success: false, message: (error as Error).message },
                HttpStatus.BAD_REQUEST,
              );
            }
          }
          this.config.updateNode(
            nodeId,
            nodeUpdates as Parameters<typeof this.config.updateNode>[1],
          );
        },
      );
      this.activeHealth.refreshSchedules();
      return { success: true, message: `Node "${nodeId}" updated` };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { success: false, message: (err as Error).message },
        HttpStatus.NOT_FOUND,
      );
    }
  }

  @Delete("nodes/:id")
  @RequireDashboardRole("admin")
  @ApiOperation({ summary: "Delete a provider node" })
  @ApiParam({ name: "id", example: "openai" })
  @ApiOkResponse({ type: ActionResponseDto })
  async deleteNode(@Param("id") nodeId: string) {
    try {
      await this.configAudit.trackChange(
        {
          action: "config.node.delete",
          target: `node:${nodeId}`,
          source: "dashboard",
          actor: { type: "dashboard", id: "dashboard" },
        },
        () => {
          // Reset circuit breaker for the node before deleting
          this.circuitBreaker.reset(nodeId);
          this.config.deleteNode(nodeId);
        },
      );
      this.activeHealth.refreshSchedules();
      return { success: true, message: `Node "${nodeId}" deleted` };
    } catch (err) {
      const status = (err as Error).message.includes("last remaining")
        ? HttpStatus.CONFLICT
        : HttpStatus.NOT_FOUND;
      throw new HttpException(
        { success: false, message: (err as Error).message },
        status,
      );
    }
  }
}

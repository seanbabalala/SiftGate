import { VIDEO_RESULT_PROFILES, type VideoResultProfile } from "../../../../src/pricing/video-result-profile.types";
import { collectLegacyPricingUpdates, legacyPriceNumber } from "@/lib/node-pricing-form";
import { Link } from "react-router-dom";
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  Plus,
  Trash2,
  ArrowLeft,
  ArrowRight,
  Settings2,
  Zap,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  Server,
  MessageSquare,
  FileText,
  MessagesSquare,
  Database,
  ListFilter,
  ImageIcon,
  Volume2,
  Video,
  Radio,
  KeyRound,
  SlidersHorizontal,
  BadgeDollarSign,
  Activity,
  Search,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { NodeIcon } from "@/components/shared/NodeIcon";
import {
  CatalogCoveragePills,
  CatalogTrustPills,
  ProviderStatusBadge,
  RecommendedModelChips,
} from "@/components/shared/CatalogSignals";
import { CapabilityPicker } from "@/components/shared/CapabilityPicker";
import { TierRecommendation } from "@/components/shared/TierRecommendation";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useTestNode, useTestExistingNode } from "@/hooks/use-mutations";
import { useProviderCatalogProviders } from "@/hooks/use-provider-catalog";
import type {
  CatalogEndpoint,
  CatalogModel,
  CatalogProvider,
  CatalogProviderFamily,
  CatalogProviderStatus,
  CatalogProviderType,
  CreateNodeRequest,
  ModelCapabilityInfo,
  NodeInfo,
  TestNodeResponse,
  UpdateNodeRequest,
} from "@/types/api";

type Protocol = CreateNodeRequest["protocol"];
type WizardStep = "provider" | "capabilities" | "models" | "settings" | "test";
type ProviderFilter = "all" | "official" | "compatible" | "custom";
type ProviderFamilyFilter = "all" | CatalogProviderFamily;
type WizardCapability =
  | "chat"
  | "responses"
  | "messages"
  | "gemini"
  | "embeddings"
  | "rerank"
  | "images"
  | "audio"
  | "video"
  | "realtime";
type ModelBucketKey =
  | "models"
  | "embedding_models"
  | "rerank_models"
  | "image_models"
  | "audio_models"
  | "video_models"
  | "realtime_models";

const PROTOCOL_ENDPOINTS: Record<Protocol, string> = {
  chat_completions: "/v1/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
  gemini: "/v1beta/models/:model:generateContent",
};

const DEFAULT_ENDPOINTS = {
  embeddings_endpoint: "/v1/embeddings",
  rerank_endpoint: "/v1/rerank",
  images_generations_endpoint: "/v1/images/generations",
  images_edits_endpoint: "/v1/images/edits",
  audio_transcriptions_endpoint: "/v1/audio/transcriptions",
  audio_speech_endpoint: "/v1/audio/speech",
  video_generations_endpoint: "/v1/videos/generations",
  video_status_endpoint: "/v1/videos/{id}",
  realtime_endpoint: "/v1/realtime",
};

const WIZARD_STEPS: Array<{ id: WizardStep; labelKey: string }> = [
  { id: "provider", labelKey: "form.wizard.provider" },
  { id: "capabilities", labelKey: "form.wizard.capabilities" },
  { id: "models", labelKey: "form.wizard.models" },
  { id: "settings", labelKey: "form.wizard.settings" },
  { id: "test", labelKey: "form.wizard.test" },
];

const CAPABILITY_OPTIONS: Array<{
  id: WizardCapability;
  labelKey: string;
  icon: LucideIcon;
}> = [
  { id: "chat", labelKey: "form.capabilityChoices.chat", icon: MessageSquare },
  {
    id: "responses",
    labelKey: "form.capabilityChoices.responses",
    icon: FileText,
  },
  {
    id: "messages",
    labelKey: "form.capabilityChoices.messages",
    icon: MessagesSquare,
  },
  {
    id: "gemini",
    labelKey: "form.capabilityChoices.gemini",
    icon: Search,
  },
  {
    id: "embeddings",
    labelKey: "form.capabilityChoices.embeddings",
    icon: Database,
  },
  { id: "rerank", labelKey: "form.capabilityChoices.rerank", icon: ListFilter },
  { id: "images", labelKey: "form.capabilityChoices.images", icon: ImageIcon },
  { id: "audio", labelKey: "form.capabilityChoices.audio", icon: Volume2 },
  { id: "video", labelKey: "form.capabilityChoices.video", icon: Video },
  { id: "realtime", labelKey: "form.capabilityChoices.realtime", icon: Radio },
];

const MODEL_BUCKETS: Array<{
  key: ModelBucketKey;
  labelKey: string;
  placeholderKey: string;
  capabilities: WizardCapability[];
}> = [
  {
    key: "models",
    labelKey: "form.buckets.textModels",
    placeholderKey: "form.placeholders.model",
    capabilities: ["chat", "responses", "messages", "gemini"],
  },
  {
    key: "embedding_models",
    labelKey: "form.buckets.embeddingModels",
    placeholderKey: "form.placeholders.embeddingModel",
    capabilities: ["embeddings"],
  },
  {
    key: "rerank_models",
    labelKey: "form.buckets.rerankModels",
    placeholderKey: "form.placeholders.rerankModel",
    capabilities: ["rerank"],
  },
  {
    key: "image_models",
    labelKey: "form.buckets.imageModels",
    placeholderKey: "form.placeholders.imageModel",
    capabilities: ["images"],
  },
  {
    key: "audio_models",
    labelKey: "form.buckets.audioModels",
    placeholderKey: "form.placeholders.audioModel",
    capabilities: ["audio"],
  },
  {
    key: "video_models",
    labelKey: "form.buckets.videoModels",
    placeholderKey: "form.placeholders.videoModel",
    capabilities: ["video"],
  },
  {
    key: "realtime_models",
    labelKey: "form.buckets.realtimeModels",
    placeholderKey: "form.placeholders.realtimeModel",
    capabilities: ["realtime"],
  },
];

const BUCKET_MODALITIES: Record<ModelBucketKey, string[]> = {
  models: ["text"],
  embedding_models: ["text", "embedding"],
  rerank_models: ["rerank"],
  image_models: ["image"],
  audio_models: ["audio"],
  video_models: ["video"],
  realtime_models: ["text", "audio", "realtime"],
};

const PROVIDER_FAMILY_FILTERS: CatalogProviderFamily[] = [
  "foundation",
  "aggregators",
  "cloud",
  "china",
  "self_hosted",
  "image_video",
  "speech_audio",
  "embedding_rerank",
];

interface ProviderPreset {
  catalog: CatalogProvider;
  id: string;
  name: string;
  description?: string;
  status?: CatalogProviderStatus;
  replacement_provider_id?: string;
  status_reason?: string;
  category: ProviderFilter;
  family: CatalogProviderFamily;
  provider_type: CatalogProviderType;
  compatibility_profile?: string;
  aliases: string[];
  logo_id?: string;
  protocol: Protocol;
  base_url: string;
  endpoint: string;
  endpoints: Partial<Record<CatalogEndpoint, string>>;
  auth_type?: "bearer" | "x-api-key" | "custom-header";
  buckets: Record<ModelBucketKey, string[]>;
  defaultBuckets: Record<ModelBucketKey, string[]>;
  suggestedCapabilities: WizardCapability[];
  model_prefixes: string[];
  capabilities: string[];
  tags: string[];
  compatibility_profiles: string[];
  keyPlaceholder: string;
  pricingRows: PricingRow[];
  hasFreshDefaults: boolean;
  hasCatalogPricingReference: boolean;
}

interface KeyValueRow {
  key: string;
  value: string;
}

interface PricingRow {
  dirty?: boolean;
  model: string;
  input: string;
  output: string;
  source?: string;
  manual_review_required?: boolean;
  pricing_trust?: NonNullable<CatalogModel["pricing_trust"]>;
}

interface CredentialRow {
  id: string;
  api_key: string;
  weight: string;
  enabled: boolean;
}

interface HealthCheckForm {
  enabled: boolean;
  interval_seconds: string;
  timeout_ms: string;
  method: "HEAD" | "GET" | "POST";
  path: string;
  lightweight_model: string;
}

interface FormState {
  id: string;
  name: string;
  protocol: Protocol;
  base_url: string;
  endpoint: string;
  api_key: string;
  timeout_ms: string;
  models: string[];
  embedding_models: string[];
  rerank_models: string[];
  image_models: string[];
  audio_models: string[];
  video_models: string[];
  realtime_models: string[];
  embeddings_endpoint: string;
  rerank_endpoint: string;
  images_generations_endpoint: string;
  images_edits_endpoint: string;
  audio_transcriptions_endpoint: string;
  audio_speech_endpoint: string;
  video_generations_endpoint: string;
  video_status_endpoint: string;
  video_result_profile: VideoResultProfile;
  realtime_endpoint: string;
  model_prefixes: string[];
  capabilities: string[];
  tags: string[];
  compatibility_profile: string[];
  aliases: KeyValueRow[];
  headers: KeyValueRow[];
  credentials: CredentialRow[];
  credential_pool_enabled: boolean;
  credential_pool_strategy: "least_in_flight" | "weighted_round_robin" | "cache_aware";
  credential_pool_sticky_by:
    | "none"
    | "agent_session"
    | "api_key"
    | "team"
    | "namespace";
  credential_pool_cooldown_ms: string;
  credential_pool_max_failures: string;
  credential_pool_retry_on_status: string;
  pricing: PricingRow[];
  auth_type: string;
  auth_header_name: string;
  auth_header_prefix: string;
  selectedCapabilities: WizardCapability[];
  max_concurrency: string;
  queue_timeout_ms: string;
  queue_policy: "wait" | "fallback" | "reject";
  health_check: HealthCheckForm;
}

interface NodeFormModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CreateNodeRequest | UpdateNodeRequest) => void;
  isPending: boolean;
  editNode?: NodeInfo | null;
  existingIds: string[];
  existingNodes: NodeInfo[];
  initialPresetId?: string | null;
}

const EMPTY_HEALTH_CHECK: HealthCheckForm = {
  enabled: false,
  interval_seconds: "30",
  timeout_ms: "5000",
  method: "HEAD",
  path: "/health",
  lightweight_model: "",
};

const EMPTY_FORM: FormState = {
  id: "",
  name: "",
  protocol: "chat_completions",
  base_url: "",
  endpoint: "/v1/chat/completions",
  api_key: "",
  timeout_ms: "30000",
  models: [""],
  embedding_models: [""],
  rerank_models: [""],
  image_models: [""],
  audio_models: [""],
  video_models: [""],
  realtime_models: [""],
  embeddings_endpoint: DEFAULT_ENDPOINTS.embeddings_endpoint,
  rerank_endpoint: DEFAULT_ENDPOINTS.rerank_endpoint,
  images_generations_endpoint: DEFAULT_ENDPOINTS.images_generations_endpoint,
  images_edits_endpoint: DEFAULT_ENDPOINTS.images_edits_endpoint,
  audio_transcriptions_endpoint:
    DEFAULT_ENDPOINTS.audio_transcriptions_endpoint,
  audio_speech_endpoint: DEFAULT_ENDPOINTS.audio_speech_endpoint,
  video_generations_endpoint: DEFAULT_ENDPOINTS.video_generations_endpoint,
  video_status_endpoint: DEFAULT_ENDPOINTS.video_status_endpoint,
  video_result_profile: "generic-v1",
  realtime_endpoint: DEFAULT_ENDPOINTS.realtime_endpoint,
  model_prefixes: [],
  capabilities: [],
  tags: [],
  compatibility_profile: [],
  aliases: [],
  headers: [],
  credentials: [],
  credential_pool_enabled: true,
  credential_pool_strategy: "least_in_flight",
  credential_pool_sticky_by: "agent_session",
  credential_pool_cooldown_ms: "60000",
  credential_pool_max_failures: "3",
  credential_pool_retry_on_status: "429,500,502,503,504",
  pricing: [],
  auth_type: "",
  auth_header_name: "",
  auth_header_prefix: "",
  selectedCapabilities: ["chat"],
  max_concurrency: "",
  queue_timeout_ms: "",
  queue_policy: "wait",
  health_check: EMPTY_HEALTH_CHECK,
};

function unique(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function compactModels(values: string[]): string[] {
  return unique(values);
}

function nonEmptyRows(rows: KeyValueRow[]): KeyValueRow[] {
  return rows.filter((row) => row.key.trim() || row.value.trim());
}

function toRecord(rows: KeyValueRow[]): Record<string, string> | undefined {
  const entries = rows
    .map((row) => [row.key.trim(), row.value.trim()] as const)
    .filter(([key, value]) => key && value);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function rowsFromRecord(record?: Record<string, string>): KeyValueRow[] {
  return Object.entries(record || {}).map(([key, value]) => ({ key, value }));
}

function ensureInputRows(values: string[]): string[] {
  return values.length > 0 ? values : [""];
}

function providerCategory(provider: CatalogProvider): ProviderFilter {
  if (
    provider.provider_type === "custom" ||
    provider.id === "openai-compatible" ||
    provider.auth_type === "custom"
  )
    return "custom";
  if (
    provider.provider_type === "aggregator" ||
    provider.provider_type === "compatible" ||
    provider.provider_type === "local"
  )
    return "compatible";
  if (
    provider.allows_unknown_models ||
    provider.tags?.includes("openai-compatible") ||
    provider.capabilities?.includes("openai_compatible") ||
    provider.capabilities?.includes("openai-compatible") ||
    ["openrouter", "together", "fireworks", "ollama", "vllm", "groq"].includes(
      provider.id,
    )
  ) {
    return "compatible";
  }
  return "official";
}

function providerFamily(provider: CatalogProvider): CatalogProviderFamily {
  return provider.family || "foundation";
}

function providerType(provider: CatalogProvider): CatalogProviderType {
  return (
    provider.provider_type ||
    (provider.allows_unknown_models ? "compatible" : "direct")
  );
}

function providerCapabilities(provider: CatalogProvider): WizardCapability[] {
  const capabilities = new Set<WizardCapability>();
  if (
    provider.protocols.includes("chat_completions") ||
    provider.endpoints.chat_completions
  )
    capabilities.add("chat");
  if (provider.protocols.includes("responses") || provider.endpoints.responses)
    capabilities.add("responses");
  if (provider.protocols.includes("messages") || provider.endpoints.messages)
    capabilities.add("messages");
  if (provider.protocols.includes("gemini") || provider.endpoints.gemini)
    capabilities.add("gemini");
  if (
    provider.endpoints.embeddings ||
    provider.modalities.includes("embedding")
  )
    capabilities.add("embeddings");
  if (provider.endpoints.rerank || provider.modalities.includes("rerank"))
    capabilities.add("rerank");
  if (
    provider.endpoints.image_generations ||
    provider.endpoints.image_edits ||
    provider.modalities.includes("image")
  )
    capabilities.add("images");
  if (
    provider.endpoints.audio_transcriptions ||
    provider.endpoints.audio_speech ||
    provider.modalities.includes("audio")
  )
    capabilities.add("audio");
  if (
    provider.endpoints.video_generations ||
    provider.endpoints.video_status ||
    provider.modalities.includes("video")
  )
    capabilities.add("video");
  if (provider.endpoints.realtime || provider.modalities.includes("realtime"))
    capabilities.add("realtime");
  return Array.from(capabilities);
}

function bucketsForModel(model: CatalogModel): ModelBucketKey[] {
  const buckets: ModelBucketKey[] = [];
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
    model.endpoints.includes("gemini") ||
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
  return [...new Set(buckets)];
}

function emptyBuckets(): Record<ModelBucketKey, string[]> {
  return Object.fromEntries(
    MODEL_BUCKETS.map((bucket) => [bucket.key, [] as string[]]),
  ) as Record<ModelBucketKey, string[]>;
}

function trimBuckets(
  buckets: Record<ModelBucketKey, string[]>,
  limits?: Partial<Record<ModelBucketKey, number>>,
): Record<ModelBucketKey, string[]> {
  const next = emptyBuckets();
  for (const bucket of MODEL_BUCKETS) {
    const values = unique(buckets[bucket.key]);
    const limit = limits?.[bucket.key];
    next[bucket.key] =
      typeof limit === "number" ? values.slice(0, limit) : values;
  }
  return next;
}

function bucketsFromProvider(
  provider: CatalogProvider,
): Record<ModelBucketKey, string[]> {
  const buckets = emptyBuckets();
  for (const bucket of MODEL_BUCKETS) {
    const providerBucket = provider.model_buckets?.[bucket.key];
    if (providerBucket && providerBucket.length > 0) {
      buckets[bucket.key] = unique(providerBucket);
    }
  }
  if (Object.values(buckets).some((values) => values.length > 0)) {
    return buckets;
  }
  for (const model of provider.models) {
    for (const bucket of bucketsForModel(model)) {
      buckets[bucket].push(model.id);
    }
  }
  return trimBuckets(buckets);
}

function defaultBucketsFromProvider(
  provider: CatalogProvider,
  suggestionBuckets: Record<ModelBucketKey, string[]>,
): Record<ModelBucketKey, string[]> {
  const recommended = emptyBuckets();
  const fallbackLimits: Partial<Record<ModelBucketKey, number>> = {
    models: 10,
    embedding_models: 6,
    rerank_models: 6,
    image_models: 6,
    audio_models: 6,
    video_models: 6,
    realtime_models: 6,
  };
  for (const bucket of MODEL_BUCKETS) {
    const providerBucket = provider.recommended_model_buckets?.[bucket.key];
    if (providerBucket && providerBucket.length > 0) {
      recommended[bucket.key] = unique(providerBucket).filter((model) =>
        suggestionBuckets[bucket.key].includes(model),
      );
      continue;
    }
    recommended[bucket.key] = suggestionBuckets[bucket.key].slice(
      0,
      fallbackLimits[bucket.key],
    );
  }
  return trimBuckets(recommended);
}

function pricingRowForModel(model: CatalogModel): PricingRow {
  return {
    model: model.id,
    input:
      model.pricing.input === null || model.pricing.input === undefined
        ? ""
        : String(model.pricing.input),
    output:
      model.pricing.output === null || model.pricing.output === undefined
        ? ""
        : String(model.pricing.output),
    source: model.pricing.source,
    manual_review_required: model.pricing.manual_review_required,
    pricing_trust: model.pricing_trust,
  };
}

function hasEditablePricing(row: PricingRow): boolean {
  return row.input.trim() !== "" || row.output.trim() !== "";
}

function providerToPreset(provider: CatalogProvider): ProviderPreset {
  const protocol =
    provider.default_protocol || provider.protocols[0] || "chat_completions";
  const buckets = bucketsFromProvider(provider);
  const defaultBuckets = defaultBucketsFromProvider(provider, buckets);
  const pricingRowsByModel = new Map(
    provider.models.map((model) => [model.id, pricingRowForModel(model)]),
  );
  const recommendedPricingRows = unique(
    MODEL_BUCKETS.flatMap((bucket) => defaultBuckets[bucket.key]),
  )
    .map((model) => pricingRowsByModel.get(model))
    .filter((row): row is PricingRow => Boolean(row))
    .filter(hasEditablePricing);
  const pricingRows =
    recommendedPricingRows.length > 0
      ? recommendedPricingRows
      : provider.models
          .map(pricingRowForModel)
          .filter(hasEditablePricing)
          .slice(0, 16);
  const hasFreshDefaults = Boolean(
    provider.recommended_models?.some(
      (entry) => entry.source === "recommended",
    ) ||
    Object.values(provider.latest_model_hints || {}).some(
      (hint) => hint?.source === "recommended",
    ),
  );
  const hasCatalogPricingReference = pricingRows.some(
    (row) => row.source && row.source !== "local",
  );

  return {
    catalog: provider,
    id: provider.id,
    name: provider.name,
    description: provider.description,
    status: provider.status,
    replacement_provider_id: provider.replacement_provider_id,
    status_reason: provider.status_reason,
    category: providerCategory(provider),
    family: providerFamily(provider),
    provider_type: providerType(provider),
    compatibility_profile: provider.compatibility_profile,
    aliases: unique([
      ...(provider.aliases || []),
      ...(provider.tags || []),
      ...(provider.model_prefixes || []),
      provider.id,
      provider.name,
    ]),
    logo_id: provider.logo_id,
    protocol,
    base_url: provider.base_url,
    endpoint:
      provider.endpoints[protocol] ||
      PROTOCOL_ENDPOINTS[protocol] ||
      "/v1/chat/completions",
    endpoints: provider.endpoints,
    auth_type:
      provider.auth_type === "bearer" ||
      provider.auth_type === "x-api-key" ||
      provider.auth_type === "custom-header"
        ? provider.auth_type
        : undefined,
    buckets,
    defaultBuckets,
    suggestedCapabilities: providerCapabilities(provider),
    model_prefixes: provider.model_prefixes || [],
    capabilities: unique(
      provider.capabilities.filter((capability) => capability !== "custom"),
    ),
    tags: provider.tags || [],
    compatibility_profiles: provider.compatibility_profiles || [],
    keyPlaceholder: provider.key_placeholder || "provider key...",
    pricingRows,
    hasFreshDefaults,
    hasCatalogPricingReference,
  };
}

function modelIdsForNode(node: NodeInfo): string[] {
  return unique([
    ...node.models,
    ...(node.embedding_models || []),
    ...(node.rerank_models || []),
    ...(node.image_models || []),
    ...(node.audio_models || []),
    ...(node.video_models || []),
    ...(node.realtime_models || []),
  ]);
}

function activeBucketKeys(
  selectedCapabilities: WizardCapability[],
): ModelBucketKey[] {
  return MODEL_BUCKETS.filter((bucket) =>
    bucket.capabilities.some((capability) =>
      selectedCapabilities.includes(capability),
    ),
  ).map((bucket) => bucket.key);
}

function deriveModalities(selectedCapabilities: WizardCapability[]): string[] {
  const modalities = new Set<string>();
  if (
    selectedCapabilities.some((capability) =>
      ["chat", "responses", "messages", "gemini"].includes(capability),
    )
  ) {
    modalities.add("text");
  }
  if (selectedCapabilities.includes("embeddings")) {
    modalities.add("text");
    modalities.add("embedding");
  }
  if (selectedCapabilities.includes("rerank")) modalities.add("rerank");
  if (selectedCapabilities.includes("images")) modalities.add("image");
  if (selectedCapabilities.includes("audio")) modalities.add("audio");
  if (selectedCapabilities.includes("video")) modalities.add("video");
  if (selectedCapabilities.includes("realtime")) modalities.add("realtime");
  return Array.from(modalities);
}

function endpointForCapability(
  preset: ProviderPreset,
  capability: WizardCapability,
): string | undefined {
  switch (capability) {
    case "chat":
      return preset.endpoints.chat_completions;
    case "responses":
      return preset.endpoints.responses;
    case "messages":
      return preset.endpoints.messages;
    case "gemini":
      return preset.endpoints.gemini;
    case "embeddings":
      return preset.endpoints.embeddings;
    case "rerank":
      return preset.endpoints.rerank;
    case "images":
      return preset.endpoints.image_generations;
    case "audio":
      return preset.endpoints.audio_transcriptions;
    case "video":
      return preset.endpoints.video_generations;
    case "realtime":
      return preset.endpoints.realtime;
  }
}

function protocolFromCapability(capability: WizardCapability): Protocol | null {
  if (capability === "chat") return "chat_completions";
  if (capability === "responses") return "responses";
  if (capability === "messages") return "messages";
  if (capability === "gemini") return "gemini";
  return null;
}

function pricingRowsFromCapabilities(
  capabilities?: Record<string, ModelCapabilityInfo>,
): PricingRow[] {
  return Object.entries(capabilities || {})
    .filter(([, capability]) => capability.pricing)
    .map(([model, capability]) => ({
      model,
      input:
        capability.pricing?.input === undefined
          ? ""
          : String(capability.pricing.input),
      output:
        capability.pricing?.output === undefined
          ? ""
          : String(capability.pricing.output),
      source: "local",
      manual_review_required: false,
      pricing_trust: "reference_estimate",
    }));
}

export function NodeFormModal({
  open,
  onClose,
  onSubmit,
  isPending,
  editNode,
  existingIds,
  existingNodes,
  initialPresetId,
}: NodeFormModalProps) {
  const { t } = useTranslation("nodes");
  const { t: priceText } = useTranslation("pricing");
  const isEdit = !!editNode;
  const [step, setStep] = useState<WizardStep>("provider");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [providerFamilyFilter, setProviderFamilyFilter] =
    useState<ProviderFamilyFilter>("all");
  const [showLegacyProviders, setShowLegacyProviders] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [removedPrices, setRemovedPrices] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestNodeResponse | null>(null);
  const [prefixInput, setPrefixInput] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [profileInput, setProfileInput] = useState("");
  const autoPickedInitialPreset = useRef(false);
  const testNode = useTestNode();
  const testExisting = useTestExistingNode();
  const providerCatalog = useProviderCatalogProviders({
    enabled: open && !isEdit,
    showLegacy: showLegacyProviders,
  });
  const providerPresets = useMemo(
    () => (providerCatalog.data?.providers || []).map(providerToPreset),
    [providerCatalog.data],
  );

  const presetInfo = selectedPreset
    ? providerPresets.find((preset) => preset.id === selectedPreset)
    : null;

  const setField = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
      setErrors((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    autoPickedInitialPreset.current = false;
    setTestResult(null);
    setPrefixInput("");
    setTagInput("");
    setProfileInput("");
    setProviderFilter("all");
    setProviderFamilyFilter("all");
    setShowLegacyProviders(false);
    setProviderSearch("");
    setErrors({});
    setRemovedPrices([]);

    if (editNode) {
      const selectedCapabilities: WizardCapability[] = [
        editNode.protocol === "chat_completions" ? "chat" : editNode.protocol,
        ...(editNode.embedding_models?.length ? ["embeddings" as const] : []),
        ...(editNode.rerank_models?.length ? ["rerank" as const] : []),
        ...(editNode.image_models?.length ? ["images" as const] : []),
        ...(editNode.audio_models?.length ? ["audio" as const] : []),
        ...(editNode.video_models?.length ? ["video" as const] : []),
        ...(editNode.realtime_models?.length ? ["realtime" as const] : []),
      ];
      setStep("settings");
      setSelectedPreset(null);
      setForm({
        ...EMPTY_FORM,
        id: editNode.id,
        name: editNode.name,
        protocol: editNode.protocol,
        base_url: editNode.base_url,
        endpoint: editNode.endpoint || PROTOCOL_ENDPOINTS[editNode.protocol],
        api_key: "",
        models: ensureInputRows(editNode.models || []),
        embedding_models: ensureInputRows(editNode.embedding_models || []),
        rerank_models: ensureInputRows(editNode.rerank_models || []),
        image_models: ensureInputRows(editNode.image_models || []),
        audio_models: ensureInputRows(editNode.audio_models || []),
        video_models: ensureInputRows(editNode.video_models || []),
        realtime_models: ensureInputRows(editNode.realtime_models || []),
        embeddings_endpoint:
          editNode.endpoints?.embeddings ||
          DEFAULT_ENDPOINTS.embeddings_endpoint,
        rerank_endpoint:
          editNode.endpoints?.rerank || DEFAULT_ENDPOINTS.rerank_endpoint,
        images_generations_endpoint:
          editNode.endpoints?.image_generations ||
          DEFAULT_ENDPOINTS.images_generations_endpoint,
        images_edits_endpoint:
          editNode.endpoints?.image_edits ||
          DEFAULT_ENDPOINTS.images_edits_endpoint,
        audio_transcriptions_endpoint:
          editNode.endpoints?.audio_transcriptions ||
          DEFAULT_ENDPOINTS.audio_transcriptions_endpoint,
        audio_speech_endpoint:
          editNode.endpoints?.audio_speech ||
          DEFAULT_ENDPOINTS.audio_speech_endpoint,
        video_generations_endpoint:
          editNode.endpoints?.video_generations ||
          DEFAULT_ENDPOINTS.video_generations_endpoint,
        video_status_endpoint:
          editNode.endpoints?.video_status ||
          DEFAULT_ENDPOINTS.video_status_endpoint,
        video_result_profile: editNode.video_result_profile ?? "generic-v1",
        realtime_endpoint:
          editNode.endpoints?.realtime || DEFAULT_ENDPOINTS.realtime_endpoint,
        model_prefixes: editNode.model_prefixes || [],
        capabilities: editNode.capabilities || [],
        tags: editNode.tags || [],
        compatibility_profile: editNode.compatibility_profile?.length
          ? editNode.compatibility_profile
          : editNode.resolved_compatibility_profiles || [],
        aliases: rowsFromRecord(editNode.aliases),
        headers: [],
        credentials: (editNode.credentials || []).map((credential) => ({
          id: credential.id,
          api_key: "",
          weight: String(credential.weight ?? 1),
          enabled: credential.enabled !== false,
        })),
        credential_pool_enabled: editNode.credential_pool?.enabled ?? true,
        credential_pool_strategy:
          editNode.credential_pool?.strategy || "least_in_flight",
        credential_pool_sticky_by:
          editNode.credential_pool?.sticky_by || "agent_session",
        credential_pool_cooldown_ms: String(
          editNode.credential_pool?.cooldown_ms ?? 60000,
        ),
        credential_pool_max_failures: String(
          editNode.credential_pool?.max_failures ?? 3,
        ),
        credential_pool_retry_on_status:
          editNode.credential_pool?.retry_on_status?.join(",") ||
          "429,500,502,503,504",
        auth_type: editNode.auth_type || "",
        auth_header_name: editNode.auth_header_name || "",
        auth_header_prefix: editNode.auth_header_prefix || "",
        timeout_ms: String(editNode.timeout_ms ?? 30000),
        max_concurrency:
          editNode.max_concurrency !== null &&
          editNode.max_concurrency !== undefined
            ? String(editNode.max_concurrency)
            : "",
        queue_timeout_ms:
          editNode.queue_timeout_ms !== null &&
          editNode.queue_timeout_ms !== undefined
            ? String(editNode.queue_timeout_ms)
            : "",
        queue_policy: editNode.queue_policy || "wait",
        health_check: {
          ...EMPTY_HEALTH_CHECK,
          ...(editNode.health_check
            ? {
                enabled: Boolean(editNode.health_check.enabled),
                interval_seconds: String(
                  editNode.health_check.interval_seconds ??
                    EMPTY_HEALTH_CHECK.interval_seconds,
                ),
                timeout_ms: String(
                  editNode.health_check.timeout_ms ??
                    EMPTY_HEALTH_CHECK.timeout_ms,
                ),
                method:
                  editNode.health_check.method ?? EMPTY_HEALTH_CHECK.method,
                path: editNode.health_check.path ?? EMPTY_HEALTH_CHECK.path,
                lightweight_model:
                  editNode.health_check.lightweight_model ??
                  EMPTY_HEALTH_CHECK.lightweight_model,
              }
            : {}),
        },
        selectedCapabilities,
        pricing: pricingRowsFromCapabilities(editNode.model_capabilities),
      });
      return;
    }

    setStep("provider");
    setSelectedPreset(null);
    setForm({ ...EMPTY_FORM, health_check: { ...EMPTY_HEALTH_CHECK } });
  }, [open, editNode]);

  useEffect(() => {
    if (!open || isEdit || !initialPresetId || providerPresets.length === 0) return;
    if (autoPickedInitialPreset.current) return;
    const preset = providerPresets.find((entry) => entry.id === initialPresetId);
    if (!preset) return;
    autoPickedInitialPreset.current = true;
    pickPreset(preset);
  }, [open, isEdit, initialPresetId, providerPresets]);

  const filteredPresets = useMemo(() => {
    const query = providerSearch.trim().toLowerCase();
    return providerPresets.filter((preset) => {
      if (providerFilter !== "all" && preset.category !== providerFilter)
        return false;
      if (
        providerFamilyFilter !== "all" &&
        preset.family !== providerFamilyFilter
      )
        return false;
      if (!query) return true;
      const modelHints = Object.values(preset.buckets).flat();
      return (
        preset.name.toLowerCase().includes(query) ||
        preset.id.toLowerCase().includes(query) ||
        preset.aliases.some((alias) => alias.toLowerCase().includes(query)) ||
        preset.model_prefixes.some((prefix) =>
          prefix.toLowerCase().includes(query),
        ) ||
        preset.tags.some((tag) => tag.toLowerCase().includes(query)) ||
        preset.capabilities.some((capability) =>
          capability.toLowerCase().includes(query),
        ) ||
        modelHints.some((model) => model.toLowerCase().includes(query)) ||
        preset.compatibility_profiles.some((profile) =>
          profile.toLowerCase().includes(query),
        )
      );
    });
  }, [providerPresets, providerFilter, providerFamilyFilter, providerSearch]);

  const currentStepIndex = WIZARD_STEPS.findIndex((item) => item.id === step);
  const activeBuckets = activeBucketKeys(form.selectedCapabilities);
  const textModelForTest = compactModels(form.models)[0];
  const allActiveModels = unique(
    activeBuckets.flatMap((bucket) => compactModels(form[bucket] as string[])),
  );

  const pickPreset = (preset: ProviderPreset) => {
    let candidateId = preset.id;
    let suffix = 2;
    while (existingIds.includes(candidateId)) {
      candidateId = `${preset.id}-${suffix}`;
      suffix += 1;
    }

    const selectedCapabilities: WizardCapability[] =
      preset.suggestedCapabilities.length > 0
        ? preset.suggestedCapabilities
        : ["chat"];

    setForm({
      ...EMPTY_FORM,
      id: candidateId,
      name: preset.name,
      protocol: preset.protocol,
      base_url: preset.base_url,
      endpoint: preset.endpoint,
      api_key: "",
      models: ensureInputRows(preset.defaultBuckets.models),
      embedding_models: ensureInputRows(preset.defaultBuckets.embedding_models),
      rerank_models: ensureInputRows(preset.defaultBuckets.rerank_models),
      image_models: ensureInputRows(preset.defaultBuckets.image_models),
      audio_models: ensureInputRows(preset.defaultBuckets.audio_models),
      video_models: ensureInputRows(preset.defaultBuckets.video_models),
      realtime_models: ensureInputRows(preset.defaultBuckets.realtime_models),
      embeddings_endpoint:
        preset.endpoints.embeddings || DEFAULT_ENDPOINTS.embeddings_endpoint,
      rerank_endpoint:
        preset.endpoints.rerank || DEFAULT_ENDPOINTS.rerank_endpoint,
      images_generations_endpoint:
        preset.endpoints.image_generations ||
        DEFAULT_ENDPOINTS.images_generations_endpoint,
      images_edits_endpoint:
        preset.endpoints.image_edits || DEFAULT_ENDPOINTS.images_edits_endpoint,
      audio_transcriptions_endpoint:
        preset.endpoints.audio_transcriptions ||
        DEFAULT_ENDPOINTS.audio_transcriptions_endpoint,
      audio_speech_endpoint:
        preset.endpoints.audio_speech ||
        DEFAULT_ENDPOINTS.audio_speech_endpoint,
      video_generations_endpoint:
        preset.endpoints.video_generations ||
        DEFAULT_ENDPOINTS.video_generations_endpoint,
      video_status_endpoint:
        preset.endpoints.video_status ||
        DEFAULT_ENDPOINTS.video_status_endpoint,
      // A provider preset must not silently retarget an existing task-result interpreter.
      video_result_profile: isEdit ? form.video_result_profile : "generic-v1",
      realtime_endpoint:
        preset.endpoints.realtime || DEFAULT_ENDPOINTS.realtime_endpoint,
      model_prefixes: [...preset.model_prefixes],
      capabilities: [...preset.capabilities],
      tags: [...preset.tags],
      compatibility_profile: [...preset.compatibility_profiles],
      auth_type: preset.auth_type || "",
      auth_header_name: "",
      auth_header_prefix: "",
      selectedCapabilities,
      pricing: preset.pricingRows.slice(0, 16),
      health_check: { ...EMPTY_HEALTH_CHECK },
    });
    setSelectedPreset(preset.id);
    setErrors({});
    setStep("capabilities");
  };

  const pickCustom = () => {
    setForm({ ...EMPTY_FORM, health_check: { ...EMPTY_HEALTH_CHECK } });
    setSelectedPreset(null);
    setErrors({});
    setStep("capabilities");
  };

  const toggleCapability = (capability: WizardCapability) => {
    const wasSelected = form.selectedCapabilities.includes(capability);
    const next = wasSelected
      ? form.selectedCapabilities.filter((item) => item !== capability)
      : [...form.selectedCapabilities, capability];
    const protocol = protocolFromCapability(capability);
    const nextTextProtocol =
      next
        .map(protocolFromCapability)
        .find((item): item is Protocol => Boolean(item)) || form.protocol;
    setForm((prev) => ({
      ...prev,
      selectedCapabilities: next,
      ...(protocol && !wasSelected
        ? {
            protocol,
            endpoint: PROTOCOL_ENDPOINTS[protocol],
          }
        : protocol && wasSelected && protocol === prev.protocol
          ? {
              protocol: nextTextProtocol,
              endpoint: PROTOCOL_ENDPOINTS[nextTextProtocol],
            }
          : {}),
    }));
    setErrors((prev) => {
      const copy = { ...prev };
      delete copy.selectedCapabilities;
      return copy;
    });
  };

  const addModel = (bucket: ModelBucketKey) =>
    setForm((prev) => ({
      ...prev,
      [bucket]: [...(prev[bucket] as string[]), ""],
    }));
  const removeModel = (bucket: ModelBucketKey, index: number) => {
    const next = (form[bucket] as string[]).filter((_, idx) => idx !== index);
    setForm((prev) => ({ ...prev, [bucket]: ensureInputRows(next) }));
  };
  const updateModel = (bucket: ModelBucketKey, index: number, value: string) =>
    setForm((prev) => ({
      ...prev,
      [bucket]: (prev[bucket] as string[]).map((item, idx) =>
        idx === index ? value : item,
      ),
    }));
  const addSuggestedModel = (bucket: ModelBucketKey, model: string) => {
    const existing = compactModels(form[bucket] as string[]);
    if (existing.includes(model)) return;
    setForm((prev) => ({ ...prev, [bucket]: [...existing, model] }));
  };

  const addPrefix = () => {
    const prefix = prefixInput.trim();
    if (prefix && !form.model_prefixes.includes(prefix)) {
      setField("model_prefixes", [...form.model_prefixes, prefix]);
    }
    setPrefixInput("");
  };
  const removePrefix = (prefix: string) =>
    setField(
      "model_prefixes",
      form.model_prefixes.filter((item) => item !== prefix),
    );

  const addTag = () => {
    const tag = tagInput.trim();
    if (tag && !form.tags.includes(tag)) setField("tags", [...form.tags, tag]);
    setTagInput("");
  };
  const removeTag = (tag: string) =>
    setField(
      "tags",
      form.tags.filter((item) => item !== tag),
    );

  const addCompatibilityProfile = () => {
    const profile = profileInput.trim();
    if (profile && !form.compatibility_profile.includes(profile)) {
      setField("compatibility_profile", [
        ...form.compatibility_profile,
        profile,
      ]);
    }
    setProfileInput("");
  };
  const removeCompatibilityProfile = (profile: string) =>
    setField(
      "compatibility_profile",
      form.compatibility_profile.filter((item) => item !== profile),
    );

  const addAlias = () =>
    setField("aliases", [...form.aliases, { key: "", value: "" }]);
  const removeAlias = (index: number) =>
    setField(
      "aliases",
      form.aliases.filter((_, idx) => idx !== index),
    );
  const updateAlias = (
    index: number,
    field: keyof KeyValueRow,
    value: string,
  ) =>
    setField(
      "aliases",
      form.aliases.map((row, idx) =>
        idx === index ? { ...row, [field]: value } : row,
      ),
    );

  const addHeader = () =>
    setField("headers", [...form.headers, { key: "", value: "" }]);
  const removeHeader = (index: number) =>
    setField(
      "headers",
      form.headers.filter((_, idx) => idx !== index),
    );
  const updateHeader = (
    index: number,
    field: keyof KeyValueRow,
    value: string,
  ) =>
    setField(
      "headers",
      form.headers.map((row, idx) =>
        idx === index ? { ...row, [field]: value } : row,
      ),
    );

  const addCredential = () =>
    setField("credentials", [
      ...form.credentials,
      {
        id: `key-${form.credentials.length + 1}`,
        api_key: "",
        weight: "1",
        enabled: true,
      },
    ]);
  const removeCredential = (index: number) =>
    setField(
      "credentials",
      form.credentials.filter((_, idx) => idx !== index),
    );
  const updateCredential = (
    index: number,
    field: keyof CredentialRow,
    value: string | boolean,
  ) =>
    setField(
      "credentials",
      form.credentials.map((row, idx) =>
        idx === index ? { ...row, [field]: value } : row,
      ),
    );

  const addPricing = () =>
    setField("pricing", [
      ...form.pricing,
      { model: "", input: "", output: "" },
    ]);
  const removePricing = (index: number) => {
    const model = form.pricing[index].model;
    if (isEdit && editNode?.configured_pricing_models?.includes(model)) {
      if (!window.confirm(t('pricing:legacy.removeConfirm', { model }))) return;
      setRemovedPrices((current) => [...new Set([...current, model])]);
    }
    setField('pricing', form.pricing.filter((_, idx) => idx !== index));
  };
  const updatePricing = (
    index: number,
    field: keyof PricingRow,
    value: string,
  ) =>
    setField(
      "pricing",
      form.pricing.map((row, idx) =>
        idx === index ? { ...row, [field]: value, dirty: true } : row,
      ),
    );

  const validateStep = (targetStep = step): boolean => {
    const errs: Record<string, string> = {};
    if (
      targetStep === "capabilities" &&
      form.selectedCapabilities.length === 0
    ) {
      errs.selectedCapabilities = t("form.errors.capabilityRequired");
    }
    if (targetStep === "models") {
      const active = activeBucketKeys(form.selectedCapabilities);
      const activeModelCount = active.reduce(
        (count, bucket) =>
          count + compactModels(form[bucket] as string[]).length,
        0,
      );
      if (activeModelCount === 0) errs.models = t("form.errors.modelRequired");
      for (const bucket of active) {
        const models = compactModels(form[bucket] as string[]);
        if (
          models.length !==
          (form[bucket] as string[]).filter((item) => item.trim()).length
        ) {
          errs[bucket] = t("form.errors.modelsUnique");
        }
      }
    }
    if (targetStep === "settings" || targetStep === "test") {
      const editedPrices = form.pricing.filter((row) => row.dirty && (row.input.trim() || row.output.trim()));
      if (editedPrices.some((row) => !row.model.trim() || !row.input.trim() || !row.output.trim() || legacyPriceNumber(row.input) === undefined || legacyPriceNumber(row.output) === undefined)) errs.pricing = t('pricing:legacy.invalid');
      if (new Set(editedPrices.map((row) => row.model.trim())).size !== editedPrices.length) errs.pricing = t('pricing:legacy.invalid');

      const credentialRows = form.credentials.filter(
        (credential) => credential.id.trim() || credential.api_key.trim(),
      );
      if (!isEdit) {
        if (!form.id.trim()) errs.id = t("form.errors.idRequired");
        else if (!/^[a-z0-9_-]+$/i.test(form.id.trim()))
          errs.id = t("form.errors.idFormat");
        else if (existingIds.includes(form.id.trim()))
          errs.id = t("form.errors.idExists");
        if (
          !form.api_key.trim() &&
          credentialRows.filter(
            (credential) => credential.id.trim() && credential.api_key.trim(),
          ).length === 0
        )
          errs.api_key = t("form.errors.apiKeyRequired");
      }
      const credentialIds = compactModels(
        credentialRows.map((credential) => credential.id),
      );
      if (credentialIds.length !== credentialRows.length) {
        errs.credentials = t("form.errors.credentialsUnique");
      }
      if (
        credentialRows.some(
          (credential) =>
            !credential.id.trim() ||
            (!isEdit && !credential.api_key.trim()) ||
            Number(credential.weight) < 1 ||
            Number.isNaN(Number(credential.weight)),
        )
      ) {
        errs.credentials = t("form.errors.credentialsInvalid");
      }
      if (!form.name.trim()) errs.name = t("form.errors.nameRequired");
      if (!form.base_url.trim())
        errs.base_url = t("form.errors.baseUrlRequired");
      if (!form.endpoint.trim())
        errs.endpoint = t("form.errors.endpointRequired");
      const timeout = Number(form.timeout_ms);
      if (Number.isNaN(timeout) || timeout < 1)
        errs.timeout_ms = t("form.errors.positiveNumber");
      if (form.max_concurrency && Number(form.max_concurrency) < 1)
        errs.max_concurrency = t("form.errors.positiveNumber");
      if (form.queue_timeout_ms && Number(form.queue_timeout_ms) < 0)
        errs.queue_timeout_ms = t("form.errors.nonNegativeNumber");
      if (form.auth_type === "custom-header" && !form.auth_header_name.trim()) {
        errs.auth_header_name = t("form.errors.customAuthHeaderRequired");
      }
      const aliasNames = compactModels(form.aliases.map((alias) => alias.key));
      if (
        aliasNames.length !==
        nonEmptyRows(form.aliases).filter((alias) => alias.key.trim()).length
      ) {
        errs.aliases = t("form.errors.aliasesUnique");
      }
      const headers = compactModels(form.headers.map((header) => header.key));
      if (
        headers.length !==
        nonEmptyRows(form.headers).filter((header) => header.key.trim()).length
      ) {
        errs.headers = t("form.errors.headersUnique");
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const goNext = () => {
    if (!validateStep(step)) return;
    const nextStep = WIZARD_STEPS[currentStepIndex + 1]?.id;
    if (nextStep) setStep(nextStep);
  };

  const goBack = () => {
    const prevStep = WIZARD_STEPS[currentStepIndex - 1]?.id;
    if (prevStep) setStep(prevStep);
  };

  const buildModelCapabilities = ():
    | Record<string, Partial<ModelCapabilityInfo>>
    | undefined => {
    const entries: Array<[string, Partial<ModelCapabilityInfo>]> = [];
    const activeModels = new Set(
      activeBucketKeys(form.selectedCapabilities).flatMap((bucket) =>
        compactModels(form[bucket] as string[]),
      ),
    );
    for (const row of form.pricing) {
      if (!row.dirty || !row.input.trim() || !row.output.trim()) continue;
      const model = row.model.trim();
      if (!model) continue;
      if (!activeModels.has(model)) continue;
      const input = Number(row.input);
      const output = Number(row.output);
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      const bucket = MODEL_BUCKETS.find((candidate) =>
        compactModels(form[candidate.key] as string[]).includes(model),
      )?.key;
      entries.push([
        model,
        {
          ...(bucket ? { modalities: BUCKET_MODALITIES[bucket] } : {}),
          pricing: { input, output },
        },
      ]);
    }
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  };

  const buildHealthCheck = () => {
    const health = form.health_check;
    if (!health.enabled) return undefined;
    return {
      enabled: health.enabled,
      interval_seconds: Number(health.interval_seconds) || undefined,
      timeout_ms: Number(health.timeout_ms) || undefined,
      method: health.method,
      path: health.path.trim() || undefined,
      lightweight_model: health.lightweight_model.trim() || undefined,
    };
  };

  const buildPayload = (): CreateNodeRequest | UpdateNodeRequest => {
    const active = activeBucketKeys(form.selectedCapabilities);
    const modelPrefixes = compactModels(form.model_prefixes);
    const tags = compactModels(form.tags);
    const aliases = toRecord(form.aliases);
    const headers = toRecord(form.headers);
    const credentials = form.credentials
      .filter((credential) => credential.id.trim() || credential.api_key.trim())
      .map((credential) => ({
        id: credential.id.trim(),
        api_key: credential.api_key.trim(),
        weight: Number(credential.weight) || 1,
        enabled: credential.enabled,
      }));
    const retryStatuses = form.credential_pool_retry_on_status
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item) && item >= 100 && item <= 599);
    const modelCapabilities = buildModelCapabilities();
    const healthCheck = buildHealthCheck();
    const textModels = active.includes("models")
      ? compactModels(form.models)
      : [];

    const basePayload: UpdateNodeRequest = {
      name: form.name.trim(),
      protocol: form.protocol,
      base_url: form.base_url.trim(),
      endpoint: form.endpoint.trim(),
      models: textModels,
      embeddings_endpoint: active.includes("embedding_models")
        ? form.embeddings_endpoint.trim()
        : undefined,
      embedding_models: active.includes("embedding_models")
        ? compactModels(form.embedding_models)
        : undefined,
      rerank_endpoint: active.includes("rerank_models")
        ? form.rerank_endpoint.trim()
        : undefined,
      rerank_models: active.includes("rerank_models")
        ? compactModels(form.rerank_models)
        : undefined,
      images_generations_endpoint: active.includes("image_models")
        ? form.images_generations_endpoint.trim()
        : undefined,
      images_edits_endpoint: active.includes("image_models")
        ? form.images_edits_endpoint.trim()
        : undefined,
      image_models: active.includes("image_models")
        ? compactModels(form.image_models)
        : undefined,
      audio_transcriptions_endpoint: active.includes("audio_models")
        ? form.audio_transcriptions_endpoint.trim()
        : undefined,
      audio_speech_endpoint: active.includes("audio_models")
        ? form.audio_speech_endpoint.trim()
        : undefined,
      audio_models: active.includes("audio_models")
        ? compactModels(form.audio_models)
        : undefined,
      video_generations_endpoint: active.includes("video_models")
        ? form.video_generations_endpoint.trim()
        : undefined,
      ...(form.video_result_profile !== (editNode?.video_result_profile ?? "generic-v1")
        ? { video_result_profile: form.video_result_profile } : {}),
      video_status_endpoint: active.includes("video_models")
        ? form.video_status_endpoint.trim()
        : undefined,
      video_models: active.includes("video_models")
        ? compactModels(form.video_models)
        : undefined,
      realtime_endpoint: active.includes("realtime_models")
        ? form.realtime_endpoint.trim()
        : undefined,
      realtime_models: active.includes("realtime_models")
        ? compactModels(form.realtime_models)
        : undefined,
      timeout_ms: Number(form.timeout_ms),
      max_concurrency: form.max_concurrency
        ? Number(form.max_concurrency)
        : undefined,
      queue_timeout_ms: form.queue_timeout_ms
        ? Number(form.queue_timeout_ms)
        : undefined,
      queue_policy:
        form.max_concurrency || form.queue_timeout_ms
          ? form.queue_policy
          : undefined,
      capabilities:
        form.capabilities.length > 0 ? form.capabilities : undefined,
      modalities: deriveModalities(form.selectedCapabilities),
      tags: tags.length > 0 ? tags : undefined,
      model_aliases: aliases,
      model_prefixes: modelPrefixes.length > 0 ? modelPrefixes : undefined,
      headers,
      credentials: credentials.length > 0 ? credentials : undefined,
      credential_pool:
        credentials.length > 0
          ? {
              enabled: form.credential_pool_enabled,
              strategy: form.credential_pool_strategy,
              sticky_by: form.credential_pool_sticky_by,
              cooldown_ms:
                Number(form.credential_pool_cooldown_ms) || undefined,
              max_failures:
                Number(form.credential_pool_max_failures) || undefined,
              retry_on_status:
                retryStatuses.length > 0 ? retryStatuses : undefined,
            }
          : undefined,
      model_capabilities: isEdit ? undefined : modelCapabilities,
      ...(isEdit ? { model_pricing_updates: collectLegacyPricingUpdates(form.pricing, removedPrices) } : {}),
      auth_type: form.auth_type
        ? (form.auth_type as "bearer" | "x-api-key" | "custom-header")
        : undefined,
      auth_header_name:
        form.auth_type === "custom-header"
          ? form.auth_header_name.trim()
          : undefined,
      auth_header_prefix:
        form.auth_type === "custom-header" && form.auth_header_prefix.trim()
          ? form.auth_header_prefix.trim()
          : undefined,
      health_check: healthCheck,
      compatibility_profile:
        form.compatibility_profile.length > 0
          ? form.compatibility_profile
          : undefined,
    };

    if (basePayload.model_pricing_updates?.length === 0) delete basePayload.model_pricing_updates;
    if (form.api_key.trim()) basePayload.api_key = form.api_key.trim();
    if (isEdit) return basePayload;

    return {
      ...basePayload,
      id: form.id.trim(),
      ...(form.api_key.trim() ? { api_key: form.api_key.trim() } : {}),
    } as CreateNodeRequest;
  };

  const handleSubmit = () => {
    if (!validateStep("settings") || !validateStep("models")) return;
    onSubmit(buildPayload());
  };

  const handleTestConnection = () => {
    setTestResult(null);
    const onResult = (result: TestNodeResponse) => setTestResult(result);
    const onFail = (err: Error) =>
      setTestResult({
        success: false,
        status: 0,
        latency_ms: 0,
        message: err.message || t("form.errors.requestFailed"),
      });

    const testApiKey =
      form.api_key.trim() ||
      form.credentials.find((credential) => credential.api_key.trim())?.api_key.trim() ||
      "";

    if (isEdit && !testApiKey) {
      testExisting.mutate(editNode!.id, {
        onSuccess: onResult,
        onError: onFail,
      });
      return;
    }

    const errs: Record<string, string> = {};
    if (!form.base_url.trim()) errs.base_url = t("form.errors.requiredForTest");
    if (!form.endpoint.trim()) errs.endpoint = t("form.errors.requiredForTest");
    if (!testApiKey) errs.api_key = t("form.errors.requiredForTest");
    if (!textModelForTest) errs.models = t("form.errors.needModelForTest");
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }

    testNode.mutate(
      {
        protocol: form.protocol,
        base_url: form.base_url.trim(),
        endpoint: form.endpoint.trim(),
        api_key: testApiKey,
        model: textModelForTest,
        auth_type: form.auth_type
          ? (form.auth_type as "bearer" | "x-api-key" | "custom-header")
          : undefined,
        auth_header_name:
          form.auth_type === "custom-header"
            ? form.auth_header_name.trim()
            : undefined,
        auth_header_prefix:
          form.auth_type === "custom-header" && form.auth_header_prefix.trim()
            ? form.auth_header_prefix.trim()
            : undefined,
        headers: toRecord(form.headers),
      },
      { onSuccess: onResult, onError: onFail },
    );
  };

  const isTestPending = testNode.isPending || testExisting.isPending;
  const isMatrixTestResult = Boolean(testResult?.matrix?.length);
  const currentNodeId = isEdit ? editNode!.id : form.id.trim();
  const otherNodes = existingNodes.filter((node) => node.id !== currentNodeId);
  const allNodeIds = existingNodes.map((node) => node.id);
  const otherModelOwners = otherNodes.flatMap((node) =>
    modelIdsForNode(node).map((model) => ({ model, nodeId: node.id })),
  );
  const allModelOwners = existingNodes.flatMap((node) =>
    modelIdsForNode(node).map((model) => ({ model, nodeId: node.id })),
  );
  const otherAliasOwners = otherNodes.flatMap((node) =>
    Object.keys(node.aliases || {}).map((alias) => ({
      alias,
      nodeId: node.id,
    })),
  );
  const otherPrefixOwners = otherNodes.flatMap((node) =>
    (node.model_prefixes || []).map((prefix) => ({ prefix, nodeId: node.id })),
  );
  const trimmedPrefixes = compactModels(form.model_prefixes);
  const trimmedAliases = form.aliases
    .map((alias) => ({ key: alias.key.trim(), value: alias.value.trim() }))
    .filter((alias) => alias.key || alias.value);
  const namingWarnings = [
    ...(!isEdit &&
    form.id.trim() &&
    allModelOwners.some((owner) => owner.model === form.id.trim())
      ? [t("form.warnings.upstreamIdMatchesModel", { id: form.id.trim() })]
      : []),
    ...allActiveModels
      .filter((model) =>
        otherModelOwners.some((owner) => owner.model === model),
      )
      .map((model) => {
        const owners = otherModelOwners
          .filter((owner) => owner.model === model)
          .map((owner) => owner.nodeId);
        return t("form.warnings.modelAlreadyListed", {
          model,
          owners: owners.join(", "),
        });
      }),
    ...trimmedAliases
      .filter(
        (alias) =>
          alias.key &&
          allModelOwners.some((owner) => owner.model === alias.key),
      )
      .map((alias) =>
        t("form.warnings.aliasMatchesModel", { alias: alias.key }),
      ),
    ...trimmedAliases
      .filter((alias) => alias.key && allNodeIds.includes(alias.key))
      .map((alias) =>
        t("form.warnings.aliasMatchesUpstream", { alias: alias.key }),
      ),
    ...trimmedAliases
      .filter(
        (alias) =>
          alias.key &&
          otherAliasOwners.some((owner) => owner.alias === alias.key),
      )
      .map((alias) => {
        const owners = otherAliasOwners
          .filter((owner) => owner.alias === alias.key)
          .map((owner) => owner.nodeId);
        return t("form.warnings.aliasAlreadyDefined", {
          alias: alias.key,
          owners: owners.join(", "),
        });
      }),
    ...trimmedAliases
      .filter(
        (alias) =>
          alias.key && alias.value && !allActiveModels.includes(alias.value),
      )
      .map((alias) =>
        t("form.warnings.aliasTargetMissing", {
          alias: alias.key,
          target: alias.value,
        }),
      ),
    ...trimmedPrefixes
      .filter((prefix) =>
        otherPrefixOwners.some((owner) => owner.prefix === prefix),
      )
      .map((prefix) => {
        const owners = otherPrefixOwners
          .filter((owner) => owner.prefix === prefix)
          .map((owner) => owner.nodeId);
        return t("form.warnings.prefixAlreadyConfigured", {
          prefix,
          owners: owners.join(", "),
        });
      }),
  ].filter((warning, idx, arr) => arr.indexOf(warning) === idx);

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-5xl p-0">
        <div className="flex min-h-[620px] flex-col">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold tracking-tight text-[var(--foreground)]">
                {isEdit
                  ? t("form.editTitle", { name: editNode!.name })
                  : presetInfo
                    ? t("form.addProviderTitle", { name: presetInfo.name })
                    : t("form.wizard.title")}
              </h2>
              <div className="mt-1 text-[11px] font-semibold text-[var(--foreground-dim)]">
                {t(
                  WIZARD_STEPS[currentStepIndex]?.labelKey ||
                    "form.wizard.provider",
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-2 text-[var(--foreground-dim)] transition-all hover:bg-[var(--inset-bg)] hover:text-[var(--foreground)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid min-h-0 flex-1 lg:grid-cols-[220px_minmax(0,1fr)]">
            <aside className="border-b border-[var(--border)] bg-[var(--background-secondary)]/70 px-4 py-4 lg:border-b-0 lg:border-r">
              <div className="space-y-2">
                {WIZARD_STEPS.map((item, index) => {
                  const active = item.id === step;
                  const complete = index < currentStepIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        if (isEdit || index <= currentStepIndex)
                          setStep(item.id);
                      }}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[12px] font-semibold transition-all ${
                        active
                          ? "bg-[var(--accent-muted)] text-[var(--accent)]"
                          : "text-[var(--foreground-muted)] hover:bg-[var(--inset-bg)] hover:text-[var(--foreground)]"
                      }`}
                    >
                      <span
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] ${
                          complete
                            ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400"
                            : active
                              ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                              : "bg-[var(--background)] text-[var(--foreground-dim)]"
                        }`}
                      >
                        {complete ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          index + 1
                        )}
                      </span>
                      <span className="truncate">{t(item.labelKey)}</span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--foreground-dim)]">
                  {t("form.summary.title")}
                </div>
                <div className="mt-2 space-y-1.5 text-[11px] font-semibold text-[var(--foreground-muted)]">
                  <SummaryLine
                    label={t("form.summary.provider")}
                    value={presetInfo?.name || form.name || t("form.custom")}
                  />
                  <SummaryLine
                    label={t("form.summary.capabilities")}
                    value={String(form.selectedCapabilities.length)}
                  />
                  <SummaryLine
                    label={t("form.summary.compatibilityProfiles")}
                    value={String(
                      form.compatibility_profile.length ||
                        presetInfo?.compatibility_profiles.length ||
                        0,
                    )}
                  />
                  <SummaryLine
                    label={t("form.summary.models")}
                    value={String(allActiveModels.length)}
                  />
                </div>
              </div>
            </aside>

            <main className="min-h-0 overflow-y-auto px-5 py-4">
              {step === "provider" && (
                  <ProviderStep
                    presets={filteredPresets}
                    loading={providerCatalog.isLoading}
                    selectedFilter={providerFilter}
                    selectedFamily={providerFamilyFilter}
                    showLegacy={showLegacyProviders}
                    search={providerSearch}
                    existingIds={existingIds}
                    onFilter={setProviderFilter}
                    onFamily={setProviderFamilyFilter}
                    onToggleLegacy={() =>
                      setShowLegacyProviders((current) => !current)
                    }
                    onSearch={setProviderSearch}
                    onPick={pickPreset}
                    onCustom={pickCustom}
                  t={t}
                />
              )}

              {step === "capabilities" && (
                <section className="space-y-4">
                  <SectionTitle
                    icon={SlidersHorizontal}
                    title={t("form.sections.capabilities")}
                  />
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {CAPABILITY_OPTIONS.map((option) => {
                      const Icon = option.icon;
                      const selected = form.selectedCapabilities.includes(
                        option.id,
                      );
                      const available =
                        !presetInfo ||
                        presetInfo.suggestedCapabilities.includes(option.id);
                      const endpoint = presetInfo
                        ? endpointForCapability(presetInfo, option.id)
                        : undefined;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => toggleCapability(option.id)}
                          className={`flex min-h-[72px] items-center gap-3 rounded-lg border px-3 py-3 text-left transition-all ${
                            selected
                              ? "border-[var(--accent)] bg-[var(--accent-muted)] text-[var(--foreground)]"
                              : "border-[var(--border)] bg-[var(--background-secondary)] text-[var(--foreground-muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)]"
                          }`}
                        >
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--background)]">
                            <Icon className="h-4 w-4" />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[13px] font-bold">
                              {t(option.labelKey)}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] font-semibold text-[var(--foreground-dim)]">
                              {available
                                ? endpoint ||
                                  t("form.capabilityChoices.catalogReady")
                                : t("form.capabilityChoices.customReady")}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {errors.selectedCapabilities && (
                    <ErrorText>{errors.selectedCapabilities}</ErrorText>
                  )}
                </section>
              )}

              {step === "models" && (
                <section className="space-y-5">
                  <SectionTitle
                    icon={Server}
                    title={t("form.sections.models")}
                  />
                  {presetInfo && (
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="blue">
                          {t("form.models.latestRecommendedTitle")}
                        </Badge>
                        {presetInfo.hasCatalogPricingReference && (
                          <Badge variant="amber">
                            {t("form.pricing.catalogReference")}
                          </Badge>
                        )}
                        <ProviderStatusBadge provider={presetInfo.catalog} dense />
                      </div>
                      <p className="mt-2 text-[11px] leading-5 text-[var(--foreground-dim)]">
                        {t("form.models.latestRecommendedDescription")}
                      </p>
                      <RecommendedModelChips
                        provider={presetInfo.catalog}
                        limit={4}
                        className="mt-2"
                      />
                      <CatalogTrustPills
                        provider={presetInfo.catalog}
                        dense
                        className="mt-2"
                      />
                    </div>
                  )}
                  {MODEL_BUCKETS.filter((bucket) =>
                    activeBuckets.includes(bucket.key),
                  ).map((bucket) => (
                    <ModelBucketEditor
                      key={bucket.key}
                      bucket={bucket}
                      values={form[bucket.key] as string[]}
                      suggestions={presetInfo?.buckets[bucket.key] || []}
                      error={
                        errors[bucket.key] ||
                        (bucket.key === "models" ? errors.models : undefined)
                      }
                      onAdd={() => addModel(bucket.key)}
                      onRemove={(index) => removeModel(bucket.key, index)}
                      onChange={(index, value) =>
                        updateModel(bucket.key, index, value)
                      }
                      onPick={(model) => addSuggestedModel(bucket.key, model)}
                      t={t}
                    />
                  ))}
                </section>
              )}

              {step === "settings" && (
                <section className="space-y-5">
                  <SectionTitle
                    icon={Settings2}
                    title={t("form.sections.settings")}
                  />
                  <div className="grid gap-4 xl:grid-cols-2">
                    <Panel title={t("form.panels.identity")} icon={Server}>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {!isEdit && (
                          <FieldGroup
                            label={t("form.labels.upstreamId")}
                            error={errors.id}
                          >
                            <Input
                              value={form.id}
                              onChange={(event) =>
                                setField("id", event.target.value)
                              }
                              placeholder={t("form.placeholders.upstreamId")}
                            />
                          </FieldGroup>
                        )}
                        <FieldGroup
                          label={t("form.labels.displayName")}
                          error={errors.name}
                        >
                          <Input
                            value={form.name}
                            onChange={(event) =>
                              setField("name", event.target.value)
                            }
                            placeholder={t("form.placeholders.displayName")}
                          />
                        </FieldGroup>
                        <FieldGroup
                          label={
                            isEdit
                              ? t("form.labels.apiKeyEdit")
                              : t("form.labels.apiKey")
                          }
                          error={errors.api_key}
                        >
                          <Input
                            type="password"
                            value={form.api_key}
                            onChange={(event) =>
                              setField("api_key", event.target.value)
                            }
                            placeholder={
                              isEdit
                                ? t("form.placeholders.keepExistingKey")
                                : presetInfo?.keyPlaceholder ||
                                  t("form.placeholders.apiKey")
                            }
                          />
                        </FieldGroup>
                        <FieldGroup label={t("form.labels.authType")}>
                          <NativeSelect
                            value={form.auth_type}
                            onChange={(event) =>
                              setField("auth_type", event.target.value)
                            }
                            options={[
                              { value: "", label: t("form.auth.auto") },
                              { value: "bearer", label: t("form.auth.bearer") },
                              {
                                value: "x-api-key",
                                label: t("form.auth.xApiKey"),
                              },
                              {
                                value: "custom-header",
                                label: t("form.auth.customHeader"),
                              },
                            ]}
                          />
                        </FieldGroup>
                        {form.auth_type === "custom-header" && (
                          <>
                            <FieldGroup
                              label={t("form.labels.authHeaderName")}
                              error={errors.auth_header_name}
                            >
                              <Input
                                value={form.auth_header_name}
                                onChange={(event) =>
                                  setField(
                                    "auth_header_name",
                                    event.target.value,
                                  )
                                }
                                placeholder={t(
                                  "form.placeholders.authHeaderName",
                                )}
                              />
                            </FieldGroup>
                            <FieldGroup
                              label={t("form.labels.authHeaderPrefix")}
                            >
                              <Input
                                value={form.auth_header_prefix}
                                onChange={(event) =>
                                  setField(
                                    "auth_header_prefix",
                                    event.target.value,
                                  )
                                }
                                placeholder={t(
                                  "form.placeholders.authHeaderPrefix",
                                )}
                              />
                            </FieldGroup>
                          </>
                        )}
                      </div>
                      {form.auth_type === "custom-header" && (
                        <p className="mt-2 text-[10px] leading-4 text-[var(--foreground-dim)]">
                          {t("form.help.customAuthHeader")}
                        </p>
                      )}
                    </Panel>

                    <Panel
                      title={t("form.panels.routingProtocol")}
                      icon={KeyRound}
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <FieldGroup label={t("form.labels.protocol")}>
                          <NativeSelect
                            value={form.protocol}
                            onChange={(event) => {
                              const protocol = event.target.value as Protocol;
                              setField("protocol", protocol);
                              setField(
                                "endpoint",
                                PROTOCOL_ENDPOINTS[protocol],
                              );
                            }}
                            options={[
                              {
                                value: "chat_completions",
                                label: t("form.protocol.chatCompletions"),
                              },
                              {
                                value: "responses",
                                label: t("form.protocol.responses"),
                              },
                              {
                                value: "messages",
                                label: t("form.protocol.messages"),
                              },
                              {
                                value: "gemini",
                                label: t("form.protocol.gemini"),
                              },
                            ]}
                          />
                        </FieldGroup>
                        <FieldGroup
                          label={t("form.labels.timeout")}
                          error={errors.timeout_ms}
                        >
                          <Input
                            type="number"
                            min={1}
                            value={form.timeout_ms}
                            onChange={(event) =>
                              setField("timeout_ms", event.target.value)
                            }
                          />
                        </FieldGroup>
                        <FieldGroup
                          label={t("form.labels.baseUrl")}
                          error={errors.base_url}
                        >
                          <Input
                            value={form.base_url}
                            onChange={(event) =>
                              setField("base_url", event.target.value)
                            }
                            placeholder={t("form.placeholders.baseUrl")}
                          />
                        </FieldGroup>
                        <FieldGroup
                          label={t("form.labels.endpoint")}
                          error={errors.endpoint}
                        >
                          <Input
                            value={form.endpoint}
                            onChange={(event) =>
                              setField("endpoint", event.target.value)
                            }
                          />
                        </FieldGroup>
                      </div>
                      <div className="mt-4">
                        <FieldGroup
                          label={t("form.labels.compatibilityProfiles")}
                        >
                          <TokenEditor
                            values={form.compatibility_profile}
                            input={profileInput}
                            placeholder={t(
                              "form.placeholders.compatibilityProfile",
                            )}
                            addLabel={t("form.actions.add")}
                            onInput={setProfileInput}
                            onAdd={addCompatibilityProfile}
                            onRemove={removeCompatibilityProfile}
                          />
                        </FieldGroup>
                        <p className="mt-2 text-[10px] leading-4 text-[var(--foreground-dim)]">
                          {t("form.help.compatibilityProfiles")}
                        </p>
                      </div>
                    </Panel>
                  </div>

                  <Panel
                    title={t("form.panels.credentials")}
                    icon={KeyRound}
                    error={errors.credentials}
                  >
                    <div className="space-y-3">
                      <div className="grid gap-3 lg:grid-cols-[1.1fr_1.5fr_96px_92px_40px]">
                        {form.credentials.map((credential, index) => (
                          <div
                            key={index}
                            className="contents"
                          >
                            <Input
                              value={credential.id}
                              onChange={(event) =>
                                updateCredential(index, "id", event.target.value)
                              }
                              placeholder={t("form.placeholders.credentialId")}
                            />
                            <Input
                              type="password"
                              value={credential.api_key}
                              onChange={(event) =>
                                updateCredential(
                                  index,
                                  "api_key",
                                  event.target.value,
                                )
                              }
                              placeholder={
                                isEdit
                                  ? t("form.placeholders.keepExistingKey")
                                  : t("form.placeholders.apiKey")
                              }
                            />
                            <Input
                              type="number"
                              min={1}
                              value={credential.weight}
                              onChange={(event) =>
                                updateCredential(
                                  index,
                                  "weight",
                                  event.target.value,
                                )
                              }
                              placeholder={t("form.placeholders.weight")}
                            />
                            <label className="flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] px-3 text-[12px] font-semibold text-[var(--foreground-muted)]">
                              <input
                                type="checkbox"
                                checked={credential.enabled}
                                onChange={(event) =>
                                  updateCredential(
                                    index,
                                    "enabled",
                                    event.target.checked,
                                  )
                                }
                              />
                              {t("form.labels.enabled")}
                            </label>
                            <button
                              type="button"
                              onClick={() => removeCredential(index)}
                              className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--foreground-dim)] hover:border-red-300 hover:text-red-600"
                              aria-label={t("form.actions.removeCredential")}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={addCredential}>
                        <Plus className="mr-2 h-4 w-4" />
                        {t("form.actions.addCredential")}
                      </Button>
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                        <label className="flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] px-3 text-[12px] font-semibold text-[var(--foreground-muted)]">
                          <input
                            type="checkbox"
                            checked={form.credential_pool_enabled}
                            onChange={(event) =>
                              setField(
                                "credential_pool_enabled",
                                event.target.checked,
                              )
                            }
                          />
                          {t("form.labels.poolEnabled")}
                        </label>
                        <FieldGroup label={t("form.labels.poolStrategy")}>
                          <NativeSelect
                            value={form.credential_pool_strategy}
                            onChange={(event) =>
                              setField(
                                "credential_pool_strategy",
                                event.target.value as FormState["credential_pool_strategy"],
                              )
                            }
                            options={[
                              {
                                value: "least_in_flight",
                                label: t("form.credentialPool.leastInFlight"),
                              },
                              {
                                value: "weighted_round_robin",
                                label: t("form.credentialPool.weightedRoundRobin"),
                              },
                              {
                                value: "cache_aware",
                                label: t("form.credentialPool.cacheAware"),
                              },
                            ]}
                          />
                        </FieldGroup>
                        <FieldGroup label={t("form.labels.poolStickyBy")}>
                          <NativeSelect
                            value={form.credential_pool_sticky_by}
                            onChange={(event) =>
                              setField(
                                "credential_pool_sticky_by",
                                event.target.value as FormState["credential_pool_sticky_by"],
                              )
                            }
                            options={[
                              { value: "agent_session", label: t("form.credentialPool.agentSession") },
                              { value: "api_key", label: t("form.credentialPool.apiKey") },
                              { value: "team", label: t("form.credentialPool.team") },
                              { value: "namespace", label: t("form.credentialPool.namespace") },
                              { value: "none", label: t("form.credentialPool.none") },
                            ]}
                          />
                        </FieldGroup>
                        <FieldGroup label={t("form.labels.poolCooldown")}>
                          <Input
                            type="number"
                            min={0}
                            value={form.credential_pool_cooldown_ms}
                            onChange={(event) =>
                              setField(
                                "credential_pool_cooldown_ms",
                                event.target.value,
                              )
                            }
                          />
                        </FieldGroup>
                        <FieldGroup label={t("form.labels.poolRetryStatus")}>
                          <Input
                            value={form.credential_pool_retry_on_status}
                            onChange={(event) =>
                              setField(
                                "credential_pool_retry_on_status",
                                event.target.value,
                              )
                            }
                          />
                        </FieldGroup>
                      </div>
                    </div>
                  </Panel>

                  <Panel
                    title={t("form.panels.endpoints")}
                    icon={SlidersHorizontal}
                  >
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {activeBuckets.includes("embedding_models") && (
                        <FieldGroup label={t("form.labels.embeddingsEndpoint")}>
                          <Input
                            value={form.embeddings_endpoint}
                            onChange={(event) =>
                              setField(
                                "embeddings_endpoint",
                                event.target.value,
                              )
                            }
                          />
                        </FieldGroup>
                      )}
                      {activeBuckets.includes("rerank_models") && (
                        <FieldGroup label={t("form.labels.rerankEndpoint")}>
                          <Input
                            value={form.rerank_endpoint}
                            onChange={(event) =>
                              setField("rerank_endpoint", event.target.value)
                            }
                          />
                        </FieldGroup>
                      )}
                      {activeBuckets.includes("image_models") && (
                        <>
                          <FieldGroup
                            label={t("form.labels.imageGenerationsEndpoint")}
                          >
                            <Input
                              value={form.images_generations_endpoint}
                              onChange={(event) =>
                                setField(
                                  "images_generations_endpoint",
                                  event.target.value,
                                )
                              }
                            />
                          </FieldGroup>
                          <FieldGroup
                            label={t("form.labels.imageEditsEndpoint")}
                          >
                            <Input
                              value={form.images_edits_endpoint}
                              onChange={(event) =>
                                setField(
                                  "images_edits_endpoint",
                                  event.target.value,
                                )
                              }
                            />
                          </FieldGroup>
                        </>
                      )}
                      {activeBuckets.includes("audio_models") && (
                        <>
                          <FieldGroup
                            label={t("form.labels.audioTranscriptionsEndpoint")}
                          >
                            <Input
                              value={form.audio_transcriptions_endpoint}
                              onChange={(event) =>
                                setField(
                                  "audio_transcriptions_endpoint",
                                  event.target.value,
                                )
                              }
                            />
                          </FieldGroup>
                          <FieldGroup
                            label={t("form.labels.audioSpeechEndpoint")}
                          >
                            <Input
                              value={form.audio_speech_endpoint}
                              onChange={(event) =>
                                setField(
                                  "audio_speech_endpoint",
                                  event.target.value,
                                )
                              }
                            />
                          </FieldGroup>
                        </>
                      )}
                      {activeBuckets.includes("video_models") && (
                        <>
                          <FieldGroup label={priceText("nativeVideo.profile")}>
                            <NativeSelect aria-label={priceText("nativeVideo.profile")} value={form.video_result_profile}
                              onChange={event => setField("video_result_profile", event.target.value as VideoResultProfile)}
                              options={VIDEO_RESULT_PROFILES.map(value => ({ value, label: priceText(`nativeVideo.${value}`) }))} />
                            <p className="mt-2 text-xs leading-5 text-[var(--foreground-muted)]">{priceText("nativeVideo.help")}</p>
                          </FieldGroup>
                          <FieldGroup
                            label={t("form.labels.videoGenerationsEndpoint")}
                          >
                            <Input
                              value={form.video_generations_endpoint}
                              onChange={(event) =>
                                setField(
                                  "video_generations_endpoint",
                                  event.target.value,
                                )
                              }
                            />
                          </FieldGroup>
                          <FieldGroup
                            label={t("form.labels.videoStatusEndpoint")}
                          >
                            <Input
                              value={form.video_status_endpoint}
                              onChange={(event) =>
                                setField(
                                  "video_status_endpoint",
                                  event.target.value,
                                )
                              }
                            />
                          </FieldGroup>
                        </>
                      )}
                      {activeBuckets.includes("realtime_models") && (
                        <FieldGroup label={t("form.labels.realtimeEndpoint")}>
                          <Input
                            value={form.realtime_endpoint}
                            onChange={(event) =>
                              setField("realtime_endpoint", event.target.value)
                            }
                          />
                        </FieldGroup>
                      )}
                    </div>
                  </Panel>

                  <div className="grid gap-4 xl:grid-cols-2">
                    <Panel
                      title={t("form.panels.headers")}
                      icon={KeyRound}
                      error={errors.headers}
                    >
                      <KeyValueEditor
                        rows={form.headers}
                        keyPlaceholder={t("form.placeholders.headerName")}
                        valuePlaceholder={t("form.placeholders.headerValue")}
                        addLabel={t("form.actions.addHeader")}
                        onAdd={addHeader}
                        onRemove={removeHeader}
                        onChange={updateHeader}
                      />
                    </Panel>

                    <Panel
                      title={t("form.panels.aliasesPrefixes")}
                      icon={Server}
                      error={errors.aliases || errors.model_prefixes}
                    >
                      <div className="space-y-4">
                        <KeyValueEditor
                          rows={form.aliases}
                          keyPlaceholder={t("form.placeholders.alias")}
                          valuePlaceholder={t("form.placeholders.modelId")}
                          addLabel={t("form.actions.addAlias")}
                          onAdd={addAlias}
                          onRemove={removeAlias}
                          onChange={updateAlias}
                        />
                        <TokenEditor
                          values={form.model_prefixes}
                          input={prefixInput}
                          placeholder={t("form.placeholders.prefix")}
                          addLabel={t("form.actions.add")}
                          onInput={setPrefixInput}
                          onAdd={addPrefix}
                          onRemove={removePrefix}
                          suffix="-*"
                        />
                      </div>
                    </Panel>
                  </div>

                  <Panel
                    title={t("form.panels.pricing")}
                    icon={BadgeDollarSign}
                  >
                    <p className="mb-3 text-xs leading-5 text-[var(--foreground-muted)]">{t('pricing:legacy.help')} <Link className="font-semibold text-[var(--accent)] underline" to={`/pricing${editNode ? `?node=${encodeURIComponent(editNode.id)}` : ''}`} onClick={onClose}>{t('pricing:legacy.open')}</Link></p>
                    {errors.pricing && <p role="alert" className="mb-3 text-xs text-[var(--destructive)]">{errors.pricing}</p>}
                    <PricingEditor
                      rows={form.pricing}
                      onAdd={addPricing}
                      onRemove={removePricing}
                      onChange={updatePricing}
                      showCatalogReferenceNote={Boolean(
                        presetInfo?.hasCatalogPricingReference ||
                        form.pricing.some(
                          (row) =>
                            (row.source && row.source !== "local") ||
                            row.pricing_trust === "review_required",
                        ),
                      )}
                      t={t}
                    />
                  </Panel>

                  <div className="grid gap-4 xl:grid-cols-2">
                    <Panel
                      title={t("form.panels.capabilityTags")}
                      icon={SlidersHorizontal}
                    >
                      <div className="space-y-4">
                        <CapabilityPicker
                          selected={form.capabilities}
                          onChange={(caps) => setField("capabilities", caps)}
                        />
                        {form.capabilities.length > 0 && (
                          <TierRecommendation
                            capabilities={form.capabilities}
                          />
                        )}
                        <TokenEditor
                          values={form.tags}
                          input={tagInput}
                          placeholder={t("form.placeholders.tag")}
                          addLabel={t("form.actions.add")}
                          onInput={setTagInput}
                          onAdd={addTag}
                          onRemove={removeTag}
                        />
                      </div>
                    </Panel>

                    <Panel title={t("form.panels.healthQueue")} icon={Activity}>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <FieldGroup
                          label={t("form.labels.maxConcurrency")}
                          error={errors.max_concurrency}
                        >
                          <Input
                            type="number"
                            min={1}
                            value={form.max_concurrency}
                            onChange={(event) =>
                              setField("max_concurrency", event.target.value)
                            }
                            placeholder="50"
                          />
                        </FieldGroup>
                        <FieldGroup
                          label={t("form.labels.queueTimeout")}
                          error={errors.queue_timeout_ms}
                        >
                          <Input
                            type="number"
                            min={0}
                            value={form.queue_timeout_ms}
                            onChange={(event) =>
                              setField("queue_timeout_ms", event.target.value)
                            }
                            placeholder="10000"
                          />
                        </FieldGroup>
                        <FieldGroup label={t("form.labels.queuePolicy")}>
                          <NativeSelect
                            value={form.queue_policy}
                            onChange={(event) =>
                              setField(
                                "queue_policy",
                                event.target.value as FormState["queue_policy"],
                              )
                            }
                            options={[
                              {
                                value: "wait",
                                label: t("form.queuePolicy.wait"),
                              },
                              {
                                value: "fallback",
                                label: t("form.queuePolicy.fallback"),
                              },
                              {
                                value: "reject",
                                label: t("form.queuePolicy.reject"),
                              },
                            ]}
                          />
                        </FieldGroup>
                        <FieldGroup label={t("form.labels.healthEnabled")}>
                          <label className="flex h-9 items-center gap-2 rounded-lg bg-[var(--background-secondary)] px-3 text-[12px] font-semibold text-[var(--foreground-muted)]">
                            <input
                              type="checkbox"
                              checked={form.health_check.enabled}
                              onChange={(event) =>
                                setField("health_check", {
                                  ...form.health_check,
                                  enabled: event.target.checked,
                                })
                              }
                            />
                            {t("form.health.enabled")}
                          </label>
                        </FieldGroup>
                        <FieldGroup label={t("form.labels.healthMethod")}>
                          <NativeSelect
                            value={form.health_check.method}
                            onChange={(event) =>
                              setField("health_check", {
                                ...form.health_check,
                                method: event.target
                                  .value as HealthCheckForm["method"],
                              })
                            }
                            options={[
                              { value: "HEAD", label: "HEAD" },
                              { value: "GET", label: "GET" },
                              { value: "POST", label: "POST" },
                            ]}
                          />
                        </FieldGroup>
                        <FieldGroup label={t("form.labels.healthPath")}>
                          <Input
                            value={form.health_check.path}
                            onChange={(event) =>
                              setField("health_check", {
                                ...form.health_check,
                                path: event.target.value,
                              })
                            }
                          />
                        </FieldGroup>
                        <FieldGroup label={t("form.labels.healthInterval")}>
                          <Input
                            type="number"
                            min={1}
                            value={form.health_check.interval_seconds}
                            onChange={(event) =>
                              setField("health_check", {
                                ...form.health_check,
                                interval_seconds: event.target.value,
                              })
                            }
                          />
                        </FieldGroup>
                        <FieldGroup label={t("form.labels.healthTimeout")}>
                          <Input
                            type="number"
                            min={1}
                            value={form.health_check.timeout_ms}
                            onChange={(event) =>
                              setField("health_check", {
                                ...form.health_check,
                                timeout_ms: event.target.value,
                              })
                            }
                          />
                        </FieldGroup>
                        <FieldGroup label={t("form.labels.healthModel")}>
                          <Input
                            value={form.health_check.lightweight_model}
                            onChange={(event) =>
                              setField("health_check", {
                                ...form.health_check,
                                lightweight_model: event.target.value,
                              })
                            }
                            placeholder={
                              textModelForTest || t("form.placeholders.modelId")
                            }
                          />
                        </FieldGroup>
                      </div>
                    </Panel>
                  </div>

                  {namingWarnings.length > 0 && (
                    <Warnings
                      warnings={namingWarnings}
                      title={t("form.warnings.title")}
                    />
                  )}
                </section>
              )}

              {step === "test" && (
                <section className="space-y-5">
                  <SectionTitle icon={Zap} title={t("form.sections.test")} />
                  <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
                    <Panel title={t("form.connectivity.title")} icon={Zap}>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0 text-[12px] font-semibold text-[var(--foreground-muted)]">
                          {textModelForTest
                            ? `${form.protocol} / ${textModelForTest}`
                            : t("form.connectivity.textOnly")}
                          {isEdit && !form.api_key.trim() && (
                            <span className="ml-2 text-[10px] text-[var(--foreground-dim)]">
                              {t("form.connectivity.usingSavedConfig")}
                            </span>
                          )}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleTestConnection}
                          disabled={isTestPending || !textModelForTest}
                        >
                          {isTestPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Zap className="h-3.5 w-3.5" />
                          )}
                          {isTestPending
                            ? t("form.connectivity.testing")
                            : t("form.connectivity.testConnection")}
                        </Button>
                      </div>
                      {testResult && (
                        <div
                          className={`mt-3 flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-xs ${
                            testResult.success
                              ? "bg-emerald-500/8 text-emerald-700 dark:text-emerald-400"
                              : "bg-red-500/8 text-red-700 dark:text-red-400"
                          }`}
                        >
                          {testResult.success ? (
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          ) : (
                            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          )}
                          <div>
                            <div className="font-semibold">
                              {testResult.message}
                            </div>
                            {testResult.latency_ms > 0 && (
                              <div className="mt-0.5 font-mono opacity-70">
                                {isMatrixTestResult
                                  ? t("form.connectivity.summaryStatus")
                                  : t("form.connectivity.providerHttp")}{" "}
                                {testResult.status} / {testResult.latency_ms}ms
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </Panel>

                    <Panel title={t("form.summary.title")} icon={Server}>
                      <div className="space-y-2 text-[12px] font-semibold text-[var(--foreground-muted)]">
                        <SummaryLine
                          label={t("form.summary.provider")}
                          value={form.name || t("form.custom")}
                        />
                        <SummaryLine
                          label={t("form.summary.baseUrl")}
                          value={form.base_url || "-"}
                        />
                        <SummaryLine
                          label={t("form.summary.models")}
                          value={String(allActiveModels.length)}
                        />
                        <SummaryLine
                          label={t("form.summary.capabilities")}
                          value={form.selectedCapabilities
                            .map((cap) => t(`form.capabilityChoices.${cap}`))
                            .join(", ")}
                        />
                        <SummaryLine
                          label={t("form.summary.compatibilityProfiles")}
                          value={
                            form.compatibility_profile.join(", ") ||
                            t("form.summary.inferred")
                          }
                        />
                      </div>
                    </Panel>
                  </div>
                </section>
              )}
            </main>
          </div>

          <div className="flex items-center justify-between border-t border-[var(--border)] px-5 py-4">
            <div>
              {!isEdit && step !== "provider" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={
                    step === "capabilities" ? () => setStep("provider") : goBack
                  }
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {t("form.actions.back")}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={onClose} disabled={isPending}>
                {t("actions.cancel")}
              </Button>
              {step !== "test" ? (
                <Button onClick={goNext}>
                  {t("form.actions.next")}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button onClick={handleSubmit} disabled={isPending}>
                  {isPending
                    ? isEdit
                      ? t("actions.saving")
                      : t("actions.creating")
                    : isEdit
                      ? t("actions.saveChanges")
                      : t("actions.createUpstream")}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProviderStep({
  presets,
  loading,
  selectedFilter,
  selectedFamily,
  showLegacy,
  search,
  existingIds,
  onFilter,
  onFamily,
  onToggleLegacy,
  onSearch,
  onPick,
  onCustom,
  t,
}: {
  presets: ProviderPreset[];
  loading: boolean;
  selectedFilter: ProviderFilter;
  selectedFamily: ProviderFamilyFilter;
  showLegacy: boolean;
  search: string;
  existingIds: string[];
  onFilter: (filter: ProviderFilter) => void;
  onFamily: (filter: ProviderFamilyFilter) => void;
  onToggleLegacy: () => void;
  onSearch: (value: string) => void;
  onPick: (preset: ProviderPreset) => void;
  onCustom: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const filters: ProviderFilter[] = ["all", "official", "compatible", "custom"];
  return (
    <section className="space-y-4">
      <SectionTitle icon={Server} title={t("form.sections.provider")} />
      <div className="rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="emerald">{t("form.providerCard.activeOnly")}</Badge>
          <Badge variant="blue">{t("catalogSignals.openrouterReference")}</Badge>
          <Badge variant="amber">{t("catalogSignals.zeroevalSecondary")}</Badge>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-[var(--foreground-dim)]">
          {t("form.providerCard.truthCopy")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-[var(--foreground-dim)]" />
          <Input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={t("form.placeholders.providerSearch")}
            className="pl-9"
          />
        </div>
        <div className="flex flex-wrap rounded-lg bg-[var(--background-secondary)] p-1">
          {filters.map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => onFilter(filter)}
              className={`rounded-md px-3 py-1.5 text-[11px] font-bold transition-all ${
                selectedFilter === filter
                  ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
                  : "text-[var(--foreground-dim)] hover:text-[var(--foreground)]"
              }`}
            >
              {t(`form.providerFilters.${filter}`)}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant={showLegacy ? "secondary" : "outline"}
          size="sm"
          onClick={onToggleLegacy}
        >
          {t(
            showLegacy
              ? "form.providerFilters.hideLegacy"
              : "form.providerFilters.showLegacy",
          )}
        </Button>
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-2">
        <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
          {t("form.providerFamilyFilter")}
        </div>
        <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-1">
          <button
            type="button"
            onClick={() => onFamily("all")}
            className={`rounded-md px-2.5 py-1.5 text-[11px] font-bold transition-all ${
              selectedFamily === "all"
                ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
                : "bg-[var(--background-tertiary)] text-[var(--foreground-dim)] hover:text-[var(--foreground)]"
            }`}
          >
            {t("form.providerFamilies.all")}
          </button>
          {PROVIDER_FAMILY_FILTERS.map((family) => (
            <button
              key={family}
              type="button"
              onClick={() => onFamily(family)}
              className={`max-w-full rounded-md px-2.5 py-1.5 text-[11px] font-bold transition-all ${
                selectedFamily === family
                  ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
                  : "bg-[var(--background-tertiary)] text-[var(--foreground-dim)] hover:text-[var(--foreground)]"
              }`}
            >
              <span className="block truncate">
                {t(`form.providerFamilies.${family}`)}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="max-h-[430px] overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {loading && (
            <div className="flex min-h-28 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--background-secondary)]">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--foreground-dim)]" />
            </div>
          )}
          {!loading && presets.length === 0 && (
            <div className="flex min-h-28 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] px-4 text-center text-[12px] font-semibold text-[var(--foreground-dim)] sm:col-span-2 xl:col-span-3">
              {t("form.providerEmpty")}
            </div>
          )}
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onPick(preset)}
              className="group flex min-h-[180px] flex-col items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-4 text-left transition-all hover:border-[var(--accent)] hover:bg-[var(--inset-bg)]"
            >
              <div className="flex w-full items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--background)]">
                  <NodeIcon
                    providerId={preset.id}
                    nodeId={preset.logo_id || preset.id}
                    providerName={preset.name}
                    baseUrl={preset.base_url}
                    modelIds={Object.values(preset.buckets).flat()}
                    tags={preset.tags}
                    protocol={preset.protocol}
                    className="h-5 w-5"
                  />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-extrabold text-[var(--foreground)]">
                    {preset.name}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-[var(--foreground-dim)]">
                    {preset.base_url}
                  </span>
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                <Badge
                  variant="blue"
                  className="max-w-[140px] truncate text-[9px]"
                >
                  {t(`form.providerFamilies.${preset.family}`)}
                </Badge>
                <Badge
                  variant="zinc"
                  className="max-w-[120px] truncate text-[9px]"
                >
                  {t(`form.providerTypes.${preset.provider_type}`)}
                </Badge>
                {preset.suggestedCapabilities.slice(0, 5).map((capability) => (
                  <Badge key={capability} variant="zinc" className="text-[9px]">
                    {t(`form.capabilityChoices.${capability}`)}
                  </Badge>
                ))}
                {preset.suggestedCapabilities.length > 5 && (
                  <Badge variant="zinc" className="text-[9px]">
                    +{preset.suggestedCapabilities.length - 5}
                  </Badge>
                )}
                {preset.hasFreshDefaults && (
                  <Badge variant="emerald" className="text-[9px]">
                    {t("form.providerCard.latestRecommended")}
                  </Badge>
                )}
                {preset.hasCatalogPricingReference && (
                  <Badge variant="amber" className="text-[9px]">
                    {t("form.providerCard.catalogPricing")}
                  </Badge>
                )}
                <ProviderStatusBadge provider={preset.catalog} dense />
              </div>
              <CatalogCoveragePills provider={preset.catalog} dense />
              <CatalogTrustPills provider={preset.catalog} dense />
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--foreground-dim)]">
                  {t("catalogSignals.recommendedPreview")}
                </div>
                <RecommendedModelChips provider={preset.catalog} limit={3} dense />
              </div>
              {preset.status_reason && (
                <span className="line-clamp-2 text-[10px] leading-4 text-[var(--foreground-dim)]">
                  {preset.status_reason}
                </span>
              )}
              {preset.replacement_provider_id && (
                <span className="text-[10px] font-semibold text-[var(--foreground-dim)]">
                  {t("form.providerCard.replacement", {
                    provider: preset.replacement_provider_id,
                  })}
                </span>
              )}
              {preset.compatibility_profiles.length > 0 && (
                <div className="flex max-w-full flex-wrap gap-1">
                  {preset.compatibility_profiles.slice(0, 2).map((profile) => (
                    <Badge
                      key={profile}
                      variant="blue"
                      className="max-w-full truncate font-mono text-[8px]"
                    >
                      {profile}
                    </Badge>
                  ))}
                  {preset.compatibility_profiles.length > 2 && (
                    <Badge variant="zinc" className="text-[8px]">
                      +{preset.compatibility_profiles.length - 2}
                    </Badge>
                  )}
                </div>
              )}
              {existingIds.includes(preset.id) && (
                <span className="text-[10px] font-semibold text-[var(--foreground-dim)]">
                  {t("form.addAnother")}
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={onCustom}
            className="flex min-h-[132px] flex-col items-start justify-between rounded-lg border border-dashed border-[var(--border)] bg-[var(--background-secondary)] p-4 text-left transition-all hover:border-[var(--accent)] hover:bg-[var(--inset-bg)]"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--background)]">
                <Settings2 className="h-5 w-5 text-[var(--foreground-dim)]" />
              </span>
              <span className="text-[13px] font-extrabold text-[var(--foreground)]">
                {t("form.custom")}
              </span>
            </span>
            <span className="font-mono text-[10px] text-[var(--foreground-dim)]">
              {t("form.providerFilters.custom")}
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}

function ModelBucketEditor({
  bucket,
  values,
  suggestions,
  error,
  onAdd,
  onRemove,
  onChange,
  onPick,
  t,
}: {
  bucket: (typeof MODEL_BUCKETS)[number];
  values: string[];
  suggestions: string[];
  error?: string;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onChange: (index: number, value: string) => void;
  onPick: (model: string) => void;
  t: (key: string) => string;
}) {
  const selected = compactModels(values);
  const remaining = suggestions
    .filter((model) => !selected.includes(model))
    .slice(0, 8);
  return (
    <Panel title={t(bucket.labelKey)} icon={Server} error={error}>
      {remaining.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {remaining.map((model) => (
            <button
              key={model}
              type="button"
              onClick={() => onPick(model)}
              className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 font-mono text-[10px] font-semibold text-[var(--foreground-muted)] transition-all hover:border-[var(--accent)] hover:text-[var(--foreground)]"
            >
              + {model}
            </button>
          ))}
        </div>
      )}
      <div className="space-y-2">
        {values.map((model, index) => (
          <div key={index} className="flex gap-2">
            <Input
              value={model}
              onChange={(event) => onChange(index, event.target.value)}
              placeholder={t(bucket.placeholderKey)}
              className="font-mono"
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onRemove(index)}
              type="button"
              disabled={values.length === 1 && !model.trim()}
            >
              <Trash2 className="h-3.5 w-3.5 text-red-500" />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={onAdd} type="button">
          <Plus className="h-3.5 w-3.5" />
          {t("form.actions.addModel")}
        </Button>
      </div>
    </Panel>
  );
}

function PricingEditor({
  rows,
  onAdd,
  onRemove,
  onChange,
  showCatalogReferenceNote,
  t,
}: {
  rows: PricingRow[];
  onAdd: () => void;
  onRemove: (index: number) => void;
  onChange: (index: number, field: keyof PricingRow, value: string) => void;
  showCatalogReferenceNote?: boolean;
  t: (key: string) => string;
}) {
  return (
    <div className="space-y-2">
      {showCatalogReferenceNote && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] px-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="amber">{t("form.pricing.catalogReference")}</Badge>
            <Badge variant="blue">{t("form.pricing.latestRecommended")}</Badge>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-[var(--foreground-dim)]">
            {t("form.pricing.referenceDescription")}
          </p>
          <p className="mt-1 text-[11px] leading-5 text-[var(--foreground-dim)]">
            {t("form.pricing.overridePriority")}
          </p>
        </div>
      )}
      {rows.map((row, index) => (
        <div
          key={`${row.model}-${index}`}
          className="grid gap-2 md:grid-cols-[minmax(180px,1fr)_120px_120px_36px]"
        >
          <Input
            value={row.model}
            onChange={(event) => onChange(index, "model", event.target.value)}
            placeholder={t("form.placeholders.modelId")}
            className="font-mono"
          />
          <Input
            value={row.input}
            onChange={(event) => onChange(index, "input", event.target.value)}
            placeholder={t("form.placeholders.priceInput")}
          />
          <Input
            value={row.output}
            onChange={(event) => onChange(index, "output", event.target.value)}
            placeholder={t("form.placeholders.priceOutput")}
          />
          <Button
            variant="ghost"
            size="icon"
            type="button"
            onClick={() => onRemove(index)}
          >
            <Trash2 className="h-3.5 w-3.5 text-red-500" />
          </Button>
          {row.pricing_trust === "aligned_estimate" && (
            <div className="md:col-span-4 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
              {t("form.pricing.alignedEstimateRow")}
            </div>
          )}
          {row.pricing_trust === "reference_estimate" && (
            <div className="md:col-span-4 text-[10px] font-semibold text-[var(--foreground-dim)]">
              {t("form.pricing.referenceRow")}
            </div>
          )}
          {row.pricing_trust === "review_required" && (
            <div className="md:col-span-4 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
              {t("form.pricing.manualReview")}
            </div>
          )}
          {!row.pricing_trust && row.manual_review_required && (
            <div className="md:col-span-4 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
              {t("form.pricing.manualReview")}
            </div>
          )}
          {!row.pricing_trust &&
            !row.manual_review_required &&
            row.source &&
            row.source !== "local" && (
              <div className="md:col-span-4 text-[10px] font-semibold text-[var(--foreground-dim)]">
                {t("form.pricing.referenceRow")}
              </div>
            )}
        </div>
      ))}
      <Button variant="outline" size="sm" type="button" onClick={onAdd}>
        <Plus className="h-3.5 w-3.5" />
        {t("form.actions.addPricing")}
      </Button>
    </div>
  );
}

function KeyValueEditor({
  rows,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  onAdd,
  onRemove,
  onChange,
}: {
  rows: KeyValueRow[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onChange: (index: number, field: keyof KeyValueRow, value: string) => void;
}) {
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_36px] gap-2"
        >
          <Input
            value={row.key}
            onChange={(event) => onChange(index, "key", event.target.value)}
            placeholder={keyPlaceholder}
          />
          <Input
            value={row.value}
            onChange={(event) => onChange(index, "value", event.target.value)}
            placeholder={valuePlaceholder}
          />
          <Button
            variant="ghost"
            size="icon"
            type="button"
            onClick={() => onRemove(index)}
          >
            <Trash2 className="h-3.5 w-3.5 text-red-500" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" type="button" onClick={onAdd}>
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

function TokenEditor({
  values,
  input,
  placeholder,
  addLabel,
  suffix = "",
  onInput,
  onAdd,
  onRemove,
}: {
  values: string[];
  input: string;
  placeholder: string;
  addLabel: string;
  suffix?: string;
  onInput: (value: string) => void;
  onAdd: () => void;
  onRemove: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--inset-bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--foreground-muted)]"
          >
            {value}
            {suffix}
            <button
              type="button"
              onClick={() => onRemove(value)}
              className="text-[var(--foreground-dim)] transition-colors hover:text-red-500"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(event) => onInput(event.target.value)}
          placeholder={placeholder}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onAdd();
            }
          }}
        />
        <Button variant="outline" size="sm" onClick={onAdd} type="button">
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

function FieldGroup({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--foreground-dim)]">
        {label}
      </label>
      {children}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

function Panel({
  title,
  icon: Icon,
  error,
  children,
}: {
  title: string;
  icon: LucideIcon;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-4">
      <div className="mb-3 flex items-center gap-2 text-[12px] font-extrabold text-[var(--foreground)]">
        <Icon className="h-4 w-4 text-[var(--foreground-dim)]" />
        {title}
      </div>
      {children}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

function SectionTitle({
  icon: Icon,
  title,
}: {
  icon: LucideIcon;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent-muted)] text-[var(--accent)]">
        <Icon className="h-4 w-4" />
      </span>
      <h3 className="text-[16px] font-extrabold text-[var(--foreground)]">
        {title}
      </h3>
    </div>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-[var(--foreground-dim)]">{label}</span>
      <span className="min-w-0 break-words text-right font-mono text-[var(--foreground)]">
        {value}
      </span>
    </div>
  );
}

function Warnings({ title, warnings }: { title: string; warnings: string[] }) {
  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/8 px-3.5 py-3 text-amber-800 dark:text-amber-300">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0">
          <div className="text-[11px] font-semibold">{title}</div>
          <div className="mt-1 space-y-1">
            {warnings.map((warning) => (
              <p key={warning} className="text-[11px] leading-5">
                {warning}
              </p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 text-[11px] font-medium text-red-500">{children}</p>
  );
}

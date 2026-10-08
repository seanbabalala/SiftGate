import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Link } from 'react-router-dom'
import {
  RefreshCw,
  RotateCcw,
  Plus,
  Pencil,
  Trash2,
  Eye,
  Type,
  Volume2,
  Server,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleDashed,
  Clapperboard,
  Gauge,
  ImageIcon,
  Database,
  ListFilter,
  Radio,
  RadioTower,
  XCircle,
  ShieldCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { DocsLinkGroup, repoDocsUrl } from '@/components/shared/DocsLinkGroup'
import { GuidanceSection } from '@/components/shared/GuidanceSection'
import { PermissionTooltip } from '@/components/shared/PermissionTooltip'
import {
  CatalogCoveragePills,
  CatalogTrustPills,
  ProviderStatusBadge,
  RecommendedModelChips,
  matchCatalogProviderForNode,
} from '@/components/shared/CatalogSignals'
import { StatusDot } from '@/components/shared/StatusDot'
import { CircuitBadge } from '@/components/shared/CircuitBadge'
import { NodeIcon } from '@/components/shared/NodeIcon'
import { CapabilityBadge } from '@/components/shared/CapabilityBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { SkeletonCard } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { NodeFormModal } from '@/components/nodes/NodeFormModal'
import { DeleteNodeDialog } from '@/components/nodes/DeleteNodeDialog'
import { QuickModelReference } from '@/components/nodes/QuickModelReference'
import { ModelPricingList } from '@/components/nodes/model-pricing-list'
import { useNodes } from '@/hooks/use-nodes'
import { useProviderCatalogProviders } from '@/hooks/use-provider-catalog'
import { useProviderHealth } from '@/hooks/use-provider-extensibility'
import { hasWorkspaceRole, useWorkspaces } from '@/hooks/use-workspaces'
import {
  useResetCircuit,
  useReloadConfig,
  useCreateNode,
  useUpdateNode,
  useDeleteNode,
  useTestExistingNode,
} from '@/hooks/use-mutations'
import { getNodeColor } from '@/lib/utils'
import { colorWithOpacity } from '@/lib/theme'
import type {
  ModelCapabilityInfo,
  NodeInfo,
  CatalogProvider,
  CreateNodeRequest,
  ProviderCompatibilityMatrixItem,
  UpdateNodeRequest,
  ProviderHealthNode,
} from '@/types/api'

// ── Modality display configuration ──
const MODALITY_DISPLAY: Record<string, {
  labelKey: string
  icon: LucideIcon
  bgClass: string
  borderClass: string
  textClass: string
}> = {
  text: {
    labelKey: 'modalities.text',
    icon: Type,
    bgClass: 'bg-stone-500/10',
    borderClass: 'border-stone-500/20',
    textClass: 'text-stone-600 dark:text-stone-400',
  },
  vision: {
    labelKey: 'modalities.vision',
    icon: Eye,
    bgClass: 'bg-purple-500/10',
    borderClass: 'border-purple-500/30',
    textClass: 'text-purple-700 dark:text-purple-400',
  },
  image: {
    labelKey: 'modalities.image',
    icon: ImageIcon,
    bgClass: 'bg-indigo-500/10',
    borderClass: 'border-indigo-500/30',
    textClass: 'text-indigo-700 dark:text-indigo-400',
  },
  audio: {
    labelKey: 'modalities.audio',
    icon: Volume2,
    bgClass: 'bg-rose-500/10',
    borderClass: 'border-rose-500/30',
    textClass: 'text-rose-700 dark:text-rose-400',
  },
  video: {
    labelKey: 'modalities.video',
    icon: Clapperboard,
    bgClass: 'bg-cyan-500/10',
    borderClass: 'border-cyan-500/30',
    textClass: 'text-cyan-700 dark:text-cyan-300',
  },
  embedding: {
    labelKey: 'modalities.embedding',
    icon: Database,
    bgClass: 'bg-sky-500/10',
    borderClass: 'border-sky-500/30',
    textClass: 'text-sky-700 dark:text-sky-400',
  },
  rerank: {
    labelKey: 'modalities.rerank',
    icon: ListFilter,
    bgClass: 'bg-amber-500/10',
    borderClass: 'border-amber-500/30',
    textClass: 'text-amber-700 dark:text-amber-400',
  },
  realtime: {
    labelKey: 'modalities.realtime',
    icon: Radio,
    bgClass: 'bg-emerald-500/10',
    borderClass: 'border-emerald-500/30',
    textClass: 'text-emerald-700 dark:text-emerald-400',
  },
}

function modelIdsForNode(node: NodeInfo): string[] {
  return Array.from(new Set([
    ...node.models,
    ...(node.embedding_models || []),
    ...(node.rerank_models || []),
    ...(node.image_models || []),
    ...(node.audio_models || []),
    ...(node.video_models || []),
    ...(node.realtime_models || []),
    ...(node.realtime?.models || []),
  ]))
}

function formatLargeNumber(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return `${value}`
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

function dimensionsLabel(dimensions: number | number[], t: TFunction): string {
  return Array.isArray(dimensions)
    ? t('capabilityTokens.dimensions', {
        value: `${dimensions.slice(0, 3).join('/')}${dimensions.length > 3 ? '+' : ''}`,
      })
    : t('capabilityTokens.dimensions', { value: dimensions })
}

function capabilityTokens(capability: ModelCapabilityInfo | undefined, t: TFunction): string[] {
  if (!capability) return []
  const tokens: string[] = []
  if (capability.supports_streaming) tokens.push(t('capabilityTokens.streaming'))
  if (capability.supports_realtime) tokens.push(t('capabilityTokens.realtime'))
  if (capability.supports_rerank) tokens.push(t('capabilityTokens.rerank'))
  if (capability.max_context_tokens) tokens.push(t('capabilityTokens.context', { value: formatLargeNumber(capability.max_context_tokens) }))
  if (capability.max_file_size) tokens.push(t('capabilityTokens.file', { value: formatFileSize(capability.max_file_size) }))
  if (capability.dimensions) tokens.push(dimensionsLabel(capability.dimensions, t))
  return tokens
}

function formatCompatibilityTime(value: string | null, t: TFunction): string {
  if (!value) return t('compatibility.never')
  return new Date(value).toLocaleString()
}

function compatibilityTone(item: ProviderCompatibilityMatrixItem): {
  icon: LucideIcon
  className: string
  labelKey: string
} {
  if (!item.configured) {
    return {
      icon: CircleDashed,
      className: 'border-[var(--divider-dim)] bg-[var(--background-secondary)] text-[var(--foreground-dim)]',
      labelKey: 'compatibility.status.notConfigured',
    }
  }
  if (!item.tested) {
    return {
      icon: CircleDashed,
      className: 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300',
      labelKey: 'compatibility.status.untested',
    }
  }
  if (item.last_status === 'pass') {
    return {
      icon: CheckCircle2,
      className: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      labelKey: 'compatibility.status.pass',
    }
  }
  if (item.last_status === 'warning') {
    return {
      icon: AlertTriangle,
      className: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      labelKey: 'compatibility.status.warning',
    }
  }
  if (item.last_status === 'skipped') {
    return {
      icon: CircleDashed,
      className: 'border-[var(--divider-dim)] bg-[var(--background-secondary)] text-[var(--foreground-dim)]',
      labelKey: 'compatibility.status.skipped',
    }
  }
  return {
    icon: XCircle,
    className: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
    labelKey: 'compatibility.status.fail',
  }
}

function configuredCompatibility(matrix: ProviderCompatibilityMatrixItem[] | undefined) {
  return (matrix || []).filter((item) => item.configured || item.profile_supported === false)
}

function onboardingProviderScore(provider: CatalogProvider): number {
  const canonicalCoverage = provider.canonical_model_coverage?.coverage_ratio || 0
  const pricingCoverage = provider.pricing_coverage?.coverage_ratio || 0
  const recommendedCount =
    provider.recommended_models?.filter((entry) => entry.source === 'recommended').length || 0
  return (
    recommendedCount * 100 +
    pricingCoverage * 10 +
    canonicalCoverage * 5 +
    provider.models.length / 100
  )
}

function providerHealthTone(status: ProviderHealthNode['availability_status']): {
  labelKey: string
  className: string
} {
  if (status === 'healthy') {
    return {
      labelKey: 'providerHealth.status.healthy',
      className: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    }
  }
  if (status === 'degraded') {
    return {
      labelKey: 'providerHealth.status.degraded',
      className: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    }
  }
  if (status === 'unhealthy') {
    return {
      labelKey: 'providerHealth.status.unhealthy',
      className: 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
    }
  }
  return {
    labelKey: 'providerHealth.status.unknown',
    className: 'border-[var(--divider-dim)] bg-[var(--background-secondary)] text-[var(--foreground-dim)]',
  }
}

function formatNullableMs(value: number | null | undefined, fallback: string): string {
  return typeof value === 'number' ? `${value}ms` : fallback
}

export function NodesPage() {
  const { t } = useTranslation('nodes')
  const { data: nodesData, isLoading, isError, error, refetch } = useNodes()
  const providerCatalog = useProviderCatalogProviders()
  const providerHealth = useProviderHealth('24h')
  const resetCircuit = useResetCircuit()
  const reloadConfig = useReloadConfig()
  const createNode = useCreateNode()
  const updateNode = useUpdateNode()
  const deleteNode = useDeleteNode()
  const testCompatibility = useTestExistingNode()
  const { data: workspaceState } = useWorkspaces()
  const canOperate = hasWorkspaceRole(workspaceState?.access, 'operator')
  const canAdmin = hasWorkspaceRole(workspaceState?.access, 'admin')

  // Modal state
  const [formOpen, setFormOpen] = useState(false)
  const [editNode, setEditNode] = useState<NodeInfo | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<NodeInfo | null>(null)
  const [initialPresetId, setInitialPresetId] = useState<string | null>(null)

  const handleOpenCreate = () => {
    setEditNode(null)
    setInitialPresetId(null)
    setFormOpen(true)
  }

  const handleOpenCreateFromCatalog = (presetId: string) => {
    setEditNode(null)
    setInitialPresetId(presetId)
    setFormOpen(true)
  }

  const handleOpenEdit = (node: NodeInfo) => {
    setEditNode(node)
    setInitialPresetId(null)
    setFormOpen(true)
  }

  const handleFormSubmit = (data: CreateNodeRequest | UpdateNodeRequest) => {
    if (editNode) {
      updateNode.mutate(
        { nodeId: editNode.id, data: data as UpdateNodeRequest },
        { onSuccess: () => setFormOpen(false) },
      )
    } else {
      createNode.mutate(data as CreateNodeRequest, {
        onSuccess: () => setFormOpen(false),
      })
    }
  }

  const handleDeleteConfirm = () => {
    if (!deleteTarget) return
    deleteNode.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    })
  }

  const handleCloseForm = () => {
    setFormOpen(false)
    setInitialPresetId(null)
  }

  if (isError) {
    return <ErrorState error={error} onRetry={refetch} />
  }

  if (isLoading || !nodesData) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('nodes.title')} description={t('nodes.description')} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} className="h-48" />)}
        </div>
      </div>
    )
  }

  const existingIds = nodesData.nodes.map((n) => n.id)
  const diagnostics = nodesData.diagnostics ?? []
  const healthyCount = nodesData.nodes.filter((node) => node.healthy).length
  const totalModels = nodesData.nodes.reduce((sum, node) => sum + modelIdsForNode(node).length, 0)
  const openCircuitCount = nodesData.nodes.filter((node) => node.circuit.state !== 'CLOSED').length
  const catalogProviders = providerCatalog.data?.providers || []
  const nodesWithCatalog = nodesData.nodes.map((node) => ({
    node,
    catalogProvider: matchCatalogProviderForNode(node, catalogProviders),
  }))
  const configuredCatalogProviderIds = new Set(
    nodesWithCatalog
      .map((entry) => entry.catalogProvider?.id)
      .filter((value): value is string => Boolean(value)),
  )
  const onboardingProviders = [...catalogProviders]
    .filter((provider) => !configuredCatalogProviderIds.has(provider.id))
    .sort((left, right) => onboardingProviderScore(right) - onboardingProviderScore(left))
    .slice(0, 6)
  const matchedCatalogCount = nodesWithCatalog.filter((entry) => entry.catalogProvider).length

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <PageHeader
          title={t('nodes.title')}
          description={t('nodes.description')}
          icon={Server}
        />
        <div className="flex w-full flex-wrap items-center gap-2.5 sm:w-auto sm:justify-end">
          <PermissionTooltip allowed={canOperate} requiredRole="operator">
            <Button
              variant="outline"
              size="sm"
              onClick={() => reloadConfig.mutate()}
              disabled={reloadConfig.isPending || !canOperate}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${reloadConfig.isPending ? 'animate-spin' : ''}`}
              />
              {reloadConfig.isPending ? t('actions.reloadingConfig') : t('actions.reloadConfig')}
            </Button>
          </PermissionTooltip>
          <PermissionTooltip allowed={canOperate} requiredRole="operator">
            <Button size="sm" onClick={handleOpenCreate} disabled={!canOperate}>
              <Plus className="h-3.5 w-3.5" />
              {t('actions.addUpstream')}
            </Button>
          </PermissionTooltip>
        </div>
      </div>

      <GuidanceSection storageKey="nodes" complete={nodesData.nodes.length > 0}>
        <DocsLinkGroup
          links={[
            { label: t('nodes.docs.providerCatalog'), href: repoDocsUrl('docs/PROVIDER_CATALOG.md#dashboard-add-node-wizard') },
            { label: t('nodes.docs.addingProviders'), href: repoDocsUrl('docs/ADDING_PROVIDERS.md') },
            { label: t('nodes.docs.compatibility'), href: repoDocsUrl('docs/PROVIDER_COMPATIBILITY.md') },
            { label: t('nodes.docs.quickstart'), href: repoDocsUrl('docs/QUICKSTART.md') },
          ]}
        />
      </GuidanceSection>

      {diagnostics.length > 0 && (
        <div className="rounded-lg bg-amber-500/10 px-4 py-3 text-amber-800 dark:text-amber-300">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <div className="text-[12px] font-semibold">
                {t('diagnostics.title')}
              </div>
              <div className="mt-1 space-y-1">
                {diagnostics.slice(0, 3).map((diagnostic, idx) => (
                  <p key={`${diagnostic.code}-${diagnostic.model ?? diagnostic.alias ?? idx}`} className="text-[11px] leading-5">
                    {diagnostic.message}
                  </p>
                ))}
                {diagnostics.length > 3 && (
                  <p className="text-[11px] font-medium">
                    {t('diagnostics.moreWarnings', { count: diagnostics.length - 3 })}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="animate-fade-up rounded-lg bg-[#052e24] p-2 shadow-[0_18px_42px_rgba(5,46,36,0.16)] dark:bg-[var(--background-secondary)]">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md bg-white/10 md:grid-cols-4">
          <div className="bg-[#052e24] px-4 py-3 dark:bg-[var(--background-secondary)]">
            <div className="flex items-center gap-2 text-[11px] font-bold text-white/52">
              <Server className="h-3.5 w-3.5" />
              {t('stats.upstreams')}
            </div>
            <div className="mt-2 font-mono text-2xl font-extrabold text-white">
              {nodesData.nodes.length}
            </div>
          </div>
          <div className="bg-[#052e24] px-4 py-3 dark:bg-[var(--background-secondary)]">
            <div className="flex items-center gap-2 text-[11px] font-bold text-white/52">
              <Gauge className="h-3.5 w-3.5" />
              {t('stats.healthy')}
            </div>
            <div className="mt-2 font-mono text-2xl font-extrabold text-white">
              {healthyCount}
              <span className="text-sm font-semibold text-white/45"> / {nodesData.nodes.length}</span>
            </div>
          </div>
          <div className="bg-[#052e24] px-4 py-3 dark:bg-[var(--background-secondary)]">
            <div className="flex items-center gap-2 text-[11px] font-bold text-white/52">
              <Boxes className="h-3.5 w-3.5" />
              {t('stats.models')}
            </div>
            <div className="mt-2 font-mono text-2xl font-extrabold text-white">
              {totalModels}
            </div>
          </div>
          <div className="bg-[#052e24] px-4 py-3 dark:bg-[var(--background-secondary)]">
            <div className="flex items-center gap-2 text-[11px] font-bold text-white/52">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('stats.openCircuits')}
            </div>
            <div className="mt-2 font-mono text-2xl font-extrabold text-white">
              {openCircuitCount}
            </div>
          </div>
        </div>
      </div>

      <CardStatic className="animate-fade-up p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('nodes.sections.onboarding.eyebrow')}
            </div>
            <h2 className="mt-1 text-[18px] font-extrabold text-[var(--foreground)]">
              {t('nodes.sections.onboarding.title')}
            </h2>
            <p className="mt-1 max-w-3xl text-[12px] leading-5 text-[var(--foreground-dim)]">
              {t('nodes.sections.onboarding.description')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="emerald">
              {t('nodes.sections.configured.catalogMatched', {
                count: matchedCatalogCount,
                total: nodesData.nodes.length,
              })}
            </Badge>
            <Badge variant="zinc">{t('catalogPage.filters.activeOnly')}</Badge>
            <Link to="/catalog">
              <Button variant="outline" size="sm">
                <Boxes className="h-3.5 w-3.5" />
                {t('nodes.sections.onboarding.openCatalog')}
              </Button>
            </Link>
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {providerCatalog.isLoading &&
            Array.from({ length: 3 }).map((_, index) => (
              <SkeletonCard key={index} className="h-44" />
            ))}
          {!providerCatalog.isLoading && onboardingProviders.length === 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] px-4 py-5 text-[12px] font-semibold text-[var(--foreground-dim)] md:col-span-2 xl:col-span-3">
              {t('nodes.sections.onboarding.empty')}
            </div>
          )}
          {onboardingProviders.map((provider) => (
            <div
              key={provider.id}
              className="rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--background)]">
                    <NodeIcon
                      providerId={provider.logo_id || provider.id}
                      providerName={provider.display_name || provider.name}
                      baseUrl={provider.base_url}
                      modelIds={provider.models.map((model) => model.id)}
                      tags={provider.tags}
                      protocol={provider.default_protocol}
                      className="h-5 w-5"
                    />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-extrabold text-[var(--foreground)]">
                      {provider.display_name || provider.name}
                    </div>
                    <div className="truncate font-mono text-[10px] text-[var(--foreground-dim)]">
                      {provider.id}
                    </div>
                  </div>
                </div>
                <ProviderStatusBadge provider={provider} dense />
              </div>
              <CatalogCoveragePills provider={provider} dense className="mt-3" />
              <CatalogTrustPills provider={provider} dense className="mt-2" />
              <div className="mt-3">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--foreground-dim)]">
                  {t('catalogSignals.recommendedPreview')}
                </div>
                <RecommendedModelChips provider={provider} limit={3} dense />
              </div>
              {provider.status_reason && (
                <p className="mt-3 line-clamp-2 text-[10px] leading-4 text-[var(--foreground-dim)]">
                  {provider.status_reason}
                </p>
              )}
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold text-[var(--foreground-dim)]">
                  {t('nodes.sections.onboarding.addHint')}
                </span>
                <PermissionTooltip allowed={canOperate} requiredRole="operator">
                  <Button
                    size="sm"
                    onClick={() => handleOpenCreateFromCatalog(provider.id)}
                    disabled={!canOperate}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('actions.addUpstream')}
                  </Button>
                </PermissionTooltip>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[10px] leading-4 text-[var(--foreground-dim)]">
          {t('nodes.sections.onboarding.legacyNote')}
        </p>
      </CardStatic>

      <CardStatic className="animate-fade-up p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('providerHealth.eyebrow')}
            </div>
            <h2 className="mt-1 text-[18px] font-extrabold text-[var(--foreground)]">
              {t('providerHealth.title')}
            </h2>
            <p className="mt-1 max-w-3xl text-[12px] leading-5 text-[var(--foreground-dim)]">
              {t('providerHealth.description')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="emerald">
              {t('providerHealth.healthyCount', {
                count: providerHealth.data?.totals.healthy_nodes ?? 0,
                total: providerHealth.data?.totals.nodes ?? nodesData.nodes.length,
              })}
            </Badge>
            <Badge variant="zinc">
              {t('providerHealth.errorRate', {
                value: providerHealth.data?.totals.error_rate ?? 0,
              })}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => providerHealth.refetch()}
              disabled={providerHealth.isFetching}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${providerHealth.isFetching ? 'animate-spin' : ''}`} />
              {t('providerHealth.refresh')}
            </Button>
          </div>
        </div>
        {providerHealth.isError && (
          <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-[12px] font-semibold text-red-700 dark:text-red-300">
            {t('providerHealth.error')}
          </div>
        )}
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {providerHealth.isLoading &&
            Array.from({ length: 3 }).map((_, index) => (
              <SkeletonCard key={index} className="h-36" />
            ))}
          {!providerHealth.isLoading &&
            (providerHealth.data?.nodes || []).slice(0, 6).map((node) => {
              const tone = providerHealthTone(node.availability_status)
              return (
                <div
                  key={node.node_id}
                  className="rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-extrabold text-[var(--foreground)]">
                        {node.provider_name}
                      </div>
                      <div className="truncate font-mono text-[10px] text-[var(--foreground-dim)]">
                        {node.node_id} / {node.base_url_host}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-md border px-2 py-1 text-[10px] font-bold ${tone.className}`}>
                      {t(tone.labelKey)}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div className="rounded-md bg-[var(--background)] px-2 py-2">
                      <div className="text-[9px] font-bold uppercase text-[var(--foreground-dim)]">
                        {t('providerHealth.calls')}
                      </div>
                      <div className="mt-1 font-mono text-[13px] font-extrabold text-[var(--foreground)]">
                        {node.metrics.calls}
                      </div>
                    </div>
                    <div className="rounded-md bg-[var(--background)] px-2 py-2">
                      <div className="text-[9px] font-bold uppercase text-[var(--foreground-dim)]">
                        {t('providerHealth.p95')}
                      </div>
                      <div className="mt-1 font-mono text-[13px] font-extrabold text-[var(--foreground)]">
                        {formatNullableMs(node.metrics.p95_latency_ms, t('providerHealth.noData'))}
                      </div>
                    </div>
                    <div className="rounded-md bg-[var(--background)] px-2 py-2">
                      <div className="text-[9px] font-bold uppercase text-[var(--foreground-dim)]">
                        {t('providerHealth.errors')}
                      </div>
                      <div className="mt-1 font-mono text-[13px] font-extrabold text-[var(--foreground)]">
                        {node.metrics.error_rate}%
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge variant="zinc" className="font-mono text-[9px]">
                      {node.health_probe.status}
                    </Badge>
                    <Badge variant="zinc" className="font-mono text-[9px]">
                      {node.circuit.state}
                    </Badge>
                    {node.auth.type === 'custom-header' && (
                      <Badge variant="blue" className="font-mono text-[9px]">
                        {node.auth.custom_header_name || 'custom-header'}
                      </Badge>
                    )}
                  </div>
                  {node.pricing_warnings.length > 0 && (
                    <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-[10px] leading-4 text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{node.pricing_warnings[0]}</span>
                    </div>
                  )}
                </div>
              )
            })}
        </div>
        <div className="mt-3 flex items-center gap-2 text-[10px] font-semibold text-[var(--foreground-dim)]">
          <ShieldCheck className="h-3.5 w-3.5" />
          {t('providerHealth.privacy')}
        </div>
      </CardStatic>

      <div className="space-y-2">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
              {t('nodes.sections.configured.eyebrow')}
            </div>
            <h2 className="text-[18px] font-extrabold text-[var(--foreground)]">
              {t('nodes.sections.configured.title')}
            </h2>
            <p className="max-w-3xl text-[12px] leading-5 text-[var(--foreground-dim)]">
              {t('nodes.sections.configured.description')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="emerald">
              {t('nodes.sections.configured.catalogMatched', {
                count: matchedCatalogCount,
                total: nodesData.nodes.length,
              })}
            </Badge>
            <Badge variant="zinc">{t('catalogSignals.explicitPricingWins')}</Badge>
          </div>
        </div>
      </div>

      {/* Node Matrix */}
      {nodesData.nodes.length === 0 ? (
        <EmptyState
          icon={Server}
          title={t('empty.title')}
          description={t('empty.description')}
          action={
            <PermissionTooltip allowed={canOperate} requiredRole="operator">
              <Button size="sm" onClick={handleOpenCreate} disabled={!canOperate}>
                <Plus className="h-3.5 w-3.5" />
                {t('actions.addUpstream')}
              </Button>
            </PermissionTooltip>
          }
        />
      ) : (
        <CardStatic className="animate-fade-up overflow-hidden p-3">
          <div className="hidden grid-cols-[minmax(210px,1.1fr)_minmax(260px,1.35fr)_minmax(190px,1fr)_170px_78px] gap-4 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--foreground-dim)] lg:grid">
            <span>{t('table.upstream')}</span>
            <span>{t('table.models')}</span>
            <span>{t('table.capabilities')}</span>
            <span>{t('table.status')}</span>
            <span className="text-right">{t('table.actions')}</span>
          </div>
          <div className="space-y-2">
            {nodesWithCatalog.map(({ node, catalogProvider }) => {
              const nodeDiagnostics = diagnostics.filter((diagnostic) =>
                diagnostic.nodes.includes(node.id) || diagnostic.matchingNodes?.includes(node.id),
              )
              const color = getNodeColor(node.id)
              const unhealthyModels = node.models.filter((model) => {
                const circuit = node.modelCircuits?.[model]
                return circuit && circuit.state !== 'CLOSED'
              })
              const concurrency = node.concurrency

              return (
                <div
                  key={node.id}
                  className="matrix-row grid gap-4 rounded-lg px-4 py-4 lg:grid-cols-[minmax(210px,1.1fr)_minmax(260px,1.35fr)_minmax(190px,1fr)_170px_78px] lg:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <div
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                        style={{ backgroundColor: colorWithOpacity(color, '12') }}
                      >
                        <NodeIcon
                          nodeId={node.id}
                          providerName={node.name}
                          baseUrl={node.base_url}
                          modelIds={modelIdsForNode(node)}
                          tags={node.tags}
                          protocol={node.protocol}
                          className="h-5 w-5"
                          style={{ color }}
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[14px] font-extrabold text-[var(--foreground)]">
                            {node.name}
                          </span>
                          <StatusDot status={node.healthy ? 'healthy' : 'unhealthy'} size="sm" pulse={false} />
                        </div>
                        <div className="truncate font-mono text-[10px] text-[var(--foreground-dim)]">
                          {node.id} / {node.protocol}
                        </div>
                        {(node.resolved_compatibility_profiles || node.compatibility_profile || []).length > 0 && (
                          <div className="mt-1 flex max-w-full flex-wrap gap-1">
                            {(node.resolved_compatibility_profiles || node.compatibility_profile || []).slice(0, 2).map((profile) => (
                              <Badge key={profile} variant="blue" className="max-w-[150px] truncate font-mono text-[8px]">
                                {profile}
                              </Badge>
                            ))}
                            {(node.resolved_compatibility_profiles || node.compatibility_profile || []).length > 2 && (
                              <Badge variant="zinc" className="text-[8px]">
                                +{(node.resolved_compatibility_profiles || node.compatibility_profile || []).length - 2}
                              </Badge>
                            )}
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {catalogProvider ? (
                            <>
                              <ProviderStatusBadge provider={catalogProvider} dense />
                              <CatalogCoveragePills provider={catalogProvider} dense />
                            </>
                          ) : (
                            <Badge variant="zinc" className="text-[9px]">
                              {t('nodes.sections.configured.operatorDefined')}
                            </Badge>
                          )}
                        </div>
                        {catalogProvider && (
                          <>
                            <CatalogTrustPills provider={catalogProvider} dense className="mt-2" />
                            <div className="mt-2">
                              <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--foreground-dim)]">
                                {t('catalogSignals.recommendedPreview')}
                              </div>
                              <RecommendedModelChips provider={catalogProvider} limit={3} dense />
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                    {nodeDiagnostics.length > 0 && (
                      <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-[11px] leading-5 text-amber-800 dark:text-amber-300">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{nodeDiagnostics[0].message}</span>
                      </div>
                    )}
                  </div>

                  <div className="min-w-0">
                    <div className="flex flex-wrap gap-1.5">
                      {modelIdsForNode(node).slice(0, 5).map((model) => {
                        const mc = node.modelCircuits?.[model]
                        const hasIssue = mc && mc.state !== 'CLOSED'
                        const capability = node.model_capabilities?.[model]
                        const isEmbedding = node.embedding_models?.includes(model)
                        return (
                          <span
                            key={model}
                            className="inline-flex min-w-[118px] max-w-full flex-col items-start gap-1 rounded-md bg-[var(--background-secondary)] px-2.5 py-1.5 text-[10px] font-semibold text-[var(--foreground-muted)]"
                          >
                            <span className="flex max-w-full items-center gap-1.5">
                              <span
                                className="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ backgroundColor: hasIssue ? 'var(--warning)' : color }}
                              />
                              <span className="truncate font-mono">{model}</span>
                              {isEmbedding && <Badge variant="blue" className="px-1.5 py-0 text-[8px]">{t('capabilityTokens.embeddingShort')}</Badge>}
                              {hasIssue && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    resetCircuit.mutate({ nodeId: node.id, model })
                                  }}
                      disabled={resetCircuit.isPending || !canOperate}
                                  className="ml-1 text-[var(--foreground-dim)] transition-colors hover:text-[var(--foreground)]"
                                  title={t('actions.resetModelCircuit')}
                                >
                                  <RotateCcw className="h-3 w-3" />
                                </button>
                              )}
                            </span>
                            {capability && (
                              <span className="flex max-w-full flex-wrap gap-1">
                                {capability.modalities.slice(0, 3).map((modality) => {
                                  const config = MODALITY_DISPLAY[modality] || MODALITY_DISPLAY.text
                                  return (
                                    <span
                                      key={modality}
                                      className={`rounded px-1.5 py-0.5 text-[8px] font-bold ${config.bgClass} ${config.textClass}`}
                                    >
                                      {t(config.labelKey)}
                                    </span>
                                  )
                                })}
                                {capabilityTokens(capability, t).slice(0, 3).map((token) => (
                                  <span
                                    key={token}
                                    className="rounded bg-[var(--background-tertiary)] px-1.5 py-0.5 text-[8px] font-bold text-[var(--foreground-dim)]"
                                  >
                                    {token}
                                  </span>
                                ))}
                              </span>
                            )}
                          </span>
                        )
                      })}
                      {modelIdsForNode(node).length > 5 && (
                        <Badge variant="zinc" className="text-[10px]">+{modelIdsForNode(node).length - 5}</Badge>
                      )}
                    </div>
                    {Object.keys(node.aliases).length > 0 && (
                      <div className="mt-2 truncate text-[10px] text-[var(--foreground-dim)]">
                        {Object.entries(node.aliases).slice(0, 3).map(([alias, target]) => (
                          <span key={alias} className="mr-2">
                            <span className="text-[var(--foreground-muted)]">{alias}</span>
                            <span className="mx-1 text-[var(--divider-dim)]">&rarr;</span>
                            <span className="font-mono">{target}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 space-y-2">
                    {node.capabilities?.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {node.capabilities.slice(0, 4).map((cap) => (
                          <CapabilityBadge key={cap} capabilityId={cap} size="sm" />
                        ))}
                        {node.capabilities.length > 4 && (
                          <Badge variant="zinc" className="text-[10px]">+{node.capabilities.length - 4}</Badge>
                        )}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {node.modalities?.map((modality) => {
                        const config = MODALITY_DISPLAY[modality] || MODALITY_DISPLAY.text
                        const Icon = config.icon
                        return (
                          <span
                            key={modality}
                            className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold ${config.bgClass} ${config.textClass}`}
                          >
                            <Icon className="h-3 w-3" />
                            {t(config.labelKey)}
                          </span>
                        )
                      })}
                      {node.tags.slice(0, 3).map((tag) => (
                        <Badge key={tag} variant="zinc" className="text-[10px]">{tag}</Badge>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 lg:block lg:space-y-2">
                    <CircuitBadge state={node.circuit.state} />
                    {concurrency && (
                      <div className="min-w-[132px] rounded-md bg-[var(--background-secondary)] px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[10px] font-semibold text-[var(--foreground-dim)]">
                            {t('status.active')}
                          </span>
                          <span className="font-mono text-[10px] font-bold text-[var(--foreground)]">
                            {concurrency.active}
                            {concurrency.max_concurrency ? ` / ${concurrency.max_concurrency}` : ''}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <span className="truncate text-[10px] font-semibold text-[var(--foreground-dim)]">
                            {t('status.queued')}
                          </span>
                          <span className="font-mono text-[10px] font-bold text-[var(--foreground)]">
                            {concurrency.queued}
                          </span>
                        </div>
                      </div>
                    )}
                    {node.realtime?.supported && (
                      <div className="min-w-[132px] rounded-md bg-[var(--background-secondary)] px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1 truncate text-[10px] font-semibold text-[var(--foreground-dim)]">
                            <RadioTower className="h-3 w-3" />
                            {t('realtime.label')}
                          </span>
                          <span className="font-mono text-[10px] font-bold text-[var(--foreground)]">
                            {node.realtime.active_connections}
                            {node.realtime.max_connections_per_node ? ` / ${node.realtime.max_connections_per_node}` : ''}
                          </span>
                        </div>
                        {node.realtime.last_error && (
                          <div className="mt-1 truncate text-[10px] font-semibold text-[var(--warning)]">
                            {node.realtime.last_error}
                          </div>
                        )}
                      </div>
                    )}
                    {node.circuit.consecutiveFailures > 0 && (
                      <div className="font-mono text-[10px] text-[var(--foreground-dim)]">
                        {t('status.failures', { count: node.circuit.consecutiveFailures })}
                      </div>
                    )}
                    {unhealthyModels.length > 0 && (
                      <div className="text-[10px] font-semibold text-[var(--warning)]">
                        {t('status.modelIssues', { count: unhealthyModels.length })}
                      </div>
                    )}
                    {node.circuit.state !== 'CLOSED' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => resetCircuit.mutate({ nodeId: node.id })}
                        disabled={resetCircuit.isPending}
                        className="h-7 px-2 text-[10px]"
                      >
                        <RotateCcw className="h-3 w-3" />
                        {t('actions.reset')}
                      </Button>
                    )}
                  </div>

                  <div className="flex items-center gap-1 lg:justify-end">
                    <button
                      onClick={() => testCompatibility.mutate(node.id)}
                      disabled={testCompatibility.isPending || !canOperate}
                      className="rounded-lg p-2 text-[var(--foreground-dim)] transition-all hover:-translate-y-0.5 hover:bg-[var(--background-secondary)] hover:text-[var(--foreground)] hover:shadow-[0_10px_24px_rgba(5,46,36,0.08)] disabled:cursor-not-allowed disabled:opacity-50"
                      title={t('compatibility.testMatrix')}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${testCompatibility.isPending ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                      onClick={() => handleOpenEdit(node)}
                      disabled={!canOperate}
                      className="rounded-lg p-2 text-[var(--foreground-dim)] transition-all hover:-translate-y-0.5 hover:bg-[var(--background-secondary)] hover:text-[var(--foreground)] hover:shadow-[0_10px_24px_rgba(5,46,36,0.08)]"
                      title={t('actions.editUpstream')}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(node)}
                      disabled={!canAdmin}
                      className="rounded-lg p-2 text-[var(--foreground-dim)] transition-all hover:-translate-y-0.5 hover:bg-red-500/10 hover:text-red-500"
                      title={t('actions.deleteUpstream')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {workspaceState && <ModelPricingList key={workspaceState.active_workspace.id} workspace={workspaceState.active_workspace.id} node={node} canManage={canAdmin} />}
                  {configuredCompatibility(node.compatibility_matrix).length > 0 && (
                    <div className="lg:col-span-5">
                      <div className="mt-1 rounded-lg border border-[var(--divider-dim)] bg-[var(--background-secondary)]/70 px-3 py-3">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-[var(--foreground-muted)]">
                              {t('compatibility.title')}
                            </div>
                            <div className="text-[10px] font-medium text-[var(--foreground-dim)]">
                              {t('compatibility.description')}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => testCompatibility.mutate(node.id)}
                            disabled={testCompatibility.isPending}
                            className="h-7 px-2 text-[10px]"
                          >
                            <RefreshCw className={`h-3 w-3 ${testCompatibility.isPending ? 'animate-spin' : ''}`} />
                            {testCompatibility.isPending ? t('compatibility.testing') : t('compatibility.testMatrix')}
                          </Button>
                        </div>
                        <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                          {configuredCompatibility(node.compatibility_matrix).map((item) => {
                            const tone = compatibilityTone(item)
                            const Icon = tone.icon
                            return (
                              <div
                                key={item.capability}
                                className={`min-w-0 rounded-md border px-2.5 py-2 ${tone.className}`}
                                title={item.failure_reason || undefined}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="inline-flex min-w-0 items-center gap-1.5 text-[10px] font-extrabold">
                                    <Icon className="h-3.5 w-3.5 shrink-0" />
                                    <span className="truncate">{t(`compatibility.capabilities.${item.capability}`)}</span>
                                  </span>
                                  <span className="shrink-0 text-[9px] font-bold uppercase">
                                    {t(tone.labelKey)}
                                  </span>
                                </div>
                                <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] font-semibold text-current/70">
                                  <span>{item.tested ? t('compatibility.tested') : t('compatibility.notTested')}</span>
                                  {item.profile_supported === false && <span>{t('compatibility.profileUnsupported')}</span>}
                                  {item.status_code !== null && <span>HTTP {item.status_code}</span>}
                                  {item.latency_ms !== null && <span>{item.latency_ms}ms</span>}
                                  <span>{formatCompatibilityTime(item.last_checked_at, t)}</span>
                                </div>
                                {item.failure_reason && (
                                  <div className="mt-1 truncate text-[9px] font-semibold text-current/80">
                                    {item.failure_reason}
                                  </div>
                                )}
                                {(item.compatibility_profiles || []).length > 0 && (
                                  <div className="mt-1 truncate font-mono text-[8px] text-current/70">
                                    {(item.compatibility_profiles || []).slice(0, 2).join(', ')}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </CardStatic>
      )}

      {nodesData.nodes.length > 0 && (
        <div className="animate-fade-up">
          <QuickModelReference nodes={nodesData.nodes} />
        </div>
      )}

      {/* Modals */}
      <NodeFormModal
        open={formOpen}
        onClose={handleCloseForm}
        onSubmit={handleFormSubmit}
        isPending={editNode ? updateNode.isPending : createNode.isPending}
        editNode={editNode}
        existingIds={existingIds}
        existingNodes={nodesData.nodes}
        initialPresetId={initialPresetId}
      />

      <DeleteNodeDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
        isPending={deleteNode.isPending}
        nodeName={deleteTarget?.name ?? ''}
        nodeId={deleteTarget?.id ?? ''}
      />
    </div>
  )
}

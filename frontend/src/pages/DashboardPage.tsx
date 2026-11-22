import { CacheReferenceNotice } from '@/components/pricing/cache-reference-notice'
import { cacheComparisonAmount, formatCacheMoney, formatCachePercent } from '@/lib/cache-reference-display'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity,
  DollarSign,
  Clock,
  Database,
  Trash2,
  BarChart3,
  PieChart as PieChartIcon,
  LayoutDashboard,
  AlertTriangle,
  CheckCircle2,
  Wallet,
  KeyRound,
  Server,
  BellRing,
  ShieldCheck,
  TrendingDown,
  Network,
  Building2,
  Layers3,
  PlayCircle,
  FileSearch,
  ArrowRight,
  Circle,
  Settings2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Route as RouteIcon,
  type LucideIcon,
} from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { GovernancePosture } from '@/components/dashboard/governance-posture'
import { ConceptPanel } from '@/components/shared/ConceptPanel'
import { DocsLinkGroup, repoDocsUrl } from '@/components/shared/DocsLinkGroup'
import { GuidanceSection } from '@/components/shared/GuidanceSection'
import { MetricCard } from '@/components/shared/MetricCard'
import { TierBadge } from '@/components/shared/TierBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { SkeletonCard, SkeletonChart, Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Tooltip } from '@/components/ui/tooltip'
import { useStats } from '@/hooks/use-stats'
import { useSSELogs } from '@/hooks/use-sse-logs'
import { useCacheStats, useClearCache } from '@/hooks/use-cache'
import { useApiKeys } from '@/hooks/use-api-keys'
import { useNamespaces } from '@/hooks/use-namespaces'
import { useBudget } from '@/hooks/use-budget'
import { useConfig } from '@/hooks/use-config'
import { useAlerts } from '@/hooks/use-alerts'
import { useGuardrails } from '@/hooks/use-guardrails'
import { useCacheSavings } from '@/hooks/use-cache-savings'
import { useClusterStatus } from '@/hooks/use-cluster-status'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { useIntelligenceSummary } from '@/hooks/use-intelligence'
import { useGovernanceDenialSummary, usePrivacyPosture } from '@/hooks/use-governance-denials'
import { useThemeColors } from '@/lib/theme'
import type { BudgetRule } from '@/types/api'
import {
  cn,
  formatNumber,
  formatTokens,
  formatCost,
  formatLatency,
  formatTimestamp,
  TIER_CHART_COLORS,
  getNodeColor,
} from '@/lib/utils'
import {
  hiddenPromptCacheCount,
  isPromptCacheLog,
  visibleNodeDistribution,
  visibleTierDistribution,
} from '@/lib/call-log-display'

type ChartTooltipPayload = {
  color?: string
  dataKey?: string | number
  name?: string | number
  value?: number | string
  payload?: Record<string, unknown>
}

type OnboardingVisibility = 'expanded' | 'collapsed'

const ONBOARDING_VISIBILITY_STORAGE_KEY = 'siftgate.dashboard.onboardingVisibility'

function readOnboardingVisibilityPreference(): OnboardingVisibility | null {
  try {
    const value = window.localStorage.getItem(ONBOARDING_VISIBILITY_STORAGE_KEY)
    return value === 'expanded' || value === 'collapsed' ? value : null
  } catch {
    return null
  }
}

function writeOnboardingVisibilityPreference(value: OnboardingVisibility) {
  try {
    window.localStorage.setItem(ONBOARDING_VISIBILITY_STORAGE_KEY, value)
  } catch {
    // Hardened browsers can disable localStorage; the computed default still works.
  }
}

function SignalTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: ChartTooltipPayload[]
  label?: string | number
}) {
  const { t } = useTranslation('dashboard')
  if (!active || !payload?.length) return null

  const primary = payload[0]?.payload
  const title =
    (typeof primary?.tier === 'string' && primary.tier) ||
    (typeof primary?.nodeId === 'string' && primary.nodeId) ||
    label

  return (
    <div className="rounded-lg bg-[var(--chart-tooltip-bg)] px-3.5 py-3 shadow-[0_22px_52px_rgba(5,46,36,0.16)]">
      <div className="mb-2 text-[11px] font-bold capitalize text-[var(--chart-tooltip-text)]">
        {title}
      </div>
      <div className="space-y-1.5">
        {payload.map((item) => {
          const key = String(item.dataKey ?? item.name ?? '')
          const value = Number(item.value ?? 0)
          const labelText =
            key === 'avgLatencyMs'
              ? t('chart.tooltip.avgLatency')
              : key === 'count'
                ? t('chart.tooltip.calls')
                : String(item.name ?? key)
          const valueText = key === 'avgLatencyMs' ? formatLatency(value) : formatNumber(value)

          return (
            <div key={`${labelText}-${valueText}`} className="flex items-center justify-between gap-5 text-[12px]">
              <span className="flex items-center gap-2 text-[var(--foreground-muted)]">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: item.color ?? 'var(--accent)' }}
                />
                {labelText}
              </span>
              <span className="font-mono font-bold text-[var(--foreground)]">{valueText}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function DashboardPage() {
  const { t, i18n } = useTranslation('dashboard')
  const formatCacheCost = (value: number | string | null | undefined) => formatCacheMoney(value, i18n.resolvedLanguage ?? i18n.language)
  const formatCacheRate = (value: number | null | undefined) => formatCachePercent(value, i18n.resolvedLanguage ?? i18n.language)
  const [apiKeyFilter, setApiKeyFilter] = useState('')
  const [namespaceFilter, setNamespaceFilter] = useState('')
  const [activeTier, setActiveTier] = useState<string | null>(null)
  const [activeNode, setActiveNode] = useState<string | null>(null)
  const [insightView, setInsightView] = useState<'tiers' | 'nodes'>('tiers')
  const [onboardingVisibilityPreference, setOnboardingVisibilityPreference] =
    useState<OnboardingVisibility | null>(() => readOnboardingVisibilityPreference())
  const { data: stats, isLoading, isError, error, refetch } = useStats({
    id: apiKeyFilter || undefined,
    namespaceId: namespaceFilter || undefined,
  })
  const secondaryQueriesEnabled = !isLoading && !isError
  const { logs: recentLogs } = useSSELogs(5, secondaryQueriesEnabled)
  const { data: cacheStats } = useCacheStats(secondaryQueriesEnabled)
  const clearCache = useClearCache()
  const { data: apiKeysData } = useApiKeys(secondaryQueriesEnabled)
  const { data: namespacesData } = useNamespaces(secondaryQueriesEnabled)
  const { data: budgetData } = useBudget({ kind: 'global' }, secondaryQueriesEnabled)
  const { data: configData } = useConfig(secondaryQueriesEnabled)
  const { data: alertsData } = useAlerts(secondaryQueriesEnabled)
  const { data: guardrailsData } = useGuardrails(secondaryQueriesEnabled)
  const { data: clusterStatus } = useClusterStatus(secondaryQueriesEnabled)
  const { data: workspaceState } = useWorkspaces()
  const { data: cacheSavings } = useCacheSavings('1d', 'node', {
    id: apiKeyFilter || undefined,
    namespaceId: namespaceFilter || undefined,
  }, secondaryQueriesEnabled)
  const { data: intelligenceSummary } = useIntelligenceSummary('1d', {
    id: apiKeyFilter || undefined,
    namespaceId: namespaceFilter || undefined,
  }, secondaryQueriesEnabled)
  const { data: denialSummary } = useGovernanceDenialSummary('24h', secondaryQueriesEnabled)
  const { data: privacyPosture } = usePrivacyPosture(secondaryQueriesEnabled)
  const colors = useThemeColors()

  const apiKeyOptions = [
    { value: '', label: t('filters.allApiKeys') },
    ...(apiKeysData?.items || []).map((key) => ({ value: key.id, label: key.name })),
  ]
  const namespaceOptions = [
    { value: '', label: t('filters.allNamespaces') },
    ...(namespacesData?.namespaces || []).map((namespace) => ({
      value: namespace.id,
      label: namespace.name || namespace.id,
    })),
  ]

  if (isError) {
    return <ErrorState error={error} onRetry={refetch} />
  }

  if (isLoading || !stats) {
    return (
      <div className="space-y-8">
        <PageHeader title={t('dashboard.title')} description={t('dashboard.description')} />
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="glass-card-static rounded-2xl p-6">
            <Skeleton className="h-4 w-32 mb-4" />
            <SkeletonChart height={200} />
          </div>
          <div className="glass-card-static rounded-2xl p-6">
            <Skeleton className="h-4 w-32 mb-4" />
            <SkeletonChart height={200} />
          </div>
        </div>
      </div>
    )
  }

  const { total } = stats
  const tierDistribution = visibleTierDistribution(stats.tierDistribution)
  const nodeDistribution = visibleNodeDistribution(stats.nodeDistribution)
  const promptCacheCount = hiddenPromptCacheCount(stats.tierDistribution, stats.nodeDistribution)
  const totalTierCalls = tierDistribution.reduce((sum, entry) => sum + entry.count, 0)
  const maxNodeCalls = Math.max(1, ...nodeDistribution.map((entry) => entry.count))
  const configDiagnostics = configData?.diagnostics || []
  const stateCategories = clusterStatus?.state
    ? Object.values(clusterStatus.state.categories)
    : []
  const sharedCategoryCount = stateCategories.filter((category) => category.shared).length
  const configuredNodeCount = configData?.nodes.filter(node => node.disabled !== true).length ?? 0
  const apiKeyCount = apiKeysData?.items.filter(key => key.status === 'active').length ?? 0
  const policyNamespaceCount = namespacesData?.namespaces.length ?? 0
  const budgetRuleCount = budgetData?.rules.filter((rule) => !rule.inherited && !rule.unset).length ?? 0
  const hasBudgetConfig = Boolean(
    (configData?.budget?.daily_token_limit ?? 0) > 0 ||
    (configData?.budget?.daily_cost_limit ?? 0) > 0 ||
    budgetRuleCount > 0,
  )
  const hasRequests = total.success > 0 || recentLogs.some(log => log.status_code >= 200 && log.status_code < 300)
  const hasEvidence = hasRequests && (tierDistribution.length > 0 || nodeDistribution.length > 0 || recentLogs.length > 0)
  const workspaceName = workspaceState?.active_workspace?.name || t('onboarding.values.pending')
  const advancedFeatureCount = [
    Object.values(configData?.routing?.tiers || {}).some((tier) => (tier.split || []).length > 0),
    Boolean(configData?.shadow?.enabled),
    Boolean(guardrailsData?.enabled),
  ].filter(Boolean).length
  const firstRunSteps = [
    {
      key: 'workspace',
      icon: Building2,
      done: Boolean(workspaceState?.active_workspace),
      title: t('onboarding.steps.workspace.title'),
      description: t('onboarding.steps.workspace.description', { workspace: workspaceName }),
      href: '/workspaces',
      action: t('onboarding.actions.reviewWorkspace'),
    },
    {
      key: 'provider',
      icon: Server,
      done: configuredNodeCount > 0,
      title: t('onboarding.steps.provider.title'),
      description: t('onboarding.steps.provider.description', { count: configuredNodeCount }),
      href: '/nodes',
      action: t('onboarding.actions.addProvider'),
    },
    {
      key: 'key',
      icon: KeyRound,
      done: apiKeyCount > 0,
      title: t('onboarding.steps.key.title'),
      description: t('onboarding.steps.key.description', { count: apiKeyCount }),
      href: '/api-keys',
      action: t('onboarding.actions.createKey'),
    },
    {
      key: 'namespace',
      icon: Layers3,
      done: true,
      optional: true,
      title: t('onboarding.steps.namespace.title'),
      description: t('onboarding.steps.namespace.description', { count: policyNamespaceCount }),
      href: '/namespaces',
      action: t('onboarding.actions.reviewNamespaces'),
    },
    {
      key: 'budget',
      icon: Wallet,
      done: hasBudgetConfig,
      title: t('onboarding.steps.budget.title'),
      description: t('onboarding.steps.budget.description'),
      href: '/budget',
      action: t('onboarding.actions.reviewBudget'),
    },
    {
      key: 'request',
      icon: PlayCircle,
      done: hasRequests,
      title: t('onboarding.steps.request.title'),
      description: t('onboarding.steps.request.description'),
      href: '/playground',
      action: t('onboarding.actions.runRequest'),
    },
    {
      key: 'evidence',
      icon: FileSearch,
      done: hasEvidence,
      title: t('onboarding.steps.evidence.title'),
      description: t('onboarding.steps.evidence.description'),
      href: '/logs',
      action: t('onboarding.actions.openEvidence'),
    },
    {
      key: 'advanced',
      icon: Settings2,
      done: true,
      optional: true,
      title: t('onboarding.steps.advanced.title'),
      description: t('onboarding.steps.advanced.description', { count: advancedFeatureCount }),
      href: '/semantic-platform',
      action: t('onboarding.actions.reviewAdvanced'),
    },
  ]
  const requiredFirstRunSteps = firstRunSteps.filter((step) => !step.optional)
  const completedFirstRunSteps = requiredFirstRunSteps.filter((step) => step.done).length
  const isFirstRunComplete = completedFirstRunSteps === requiredFirstRunSteps.length
  const nextFirstRunStep = requiredFirstRunSteps.find((step) => !step.done)
  const onboardingCollapsed =
    onboardingVisibilityPreference === null
      ? isFirstRunComplete
      : onboardingVisibilityPreference === 'collapsed'
  const toggleOnboarding = () => {
    const nextVisibility: OnboardingVisibility = onboardingCollapsed ? 'expanded' : 'collapsed'
    setOnboardingVisibilityPreference(nextVisibility)
    writeOnboardingVisibilityPreference(nextVisibility)
  }
  const setupWarnings = [
    ...(apiKeysData && apiKeysData.items.length === 0
      ? [t('configHealth.missingApiKey')]
      : []),
    ...configDiagnostics.map((diagnostic) => diagnostic.message),
  ]

  const topBudgetRule = (budgetData?.rules || [])
    .filter((rule) => !rule.inherited && !rule.unset && rule.limit > 0)
    .reduce<BudgetRule | null>((top, rule) => (!top || rule.percentage > top.percentage ? rule : top), null)
  const optimizerSavings = intelligenceSummary?.summary.estimated_savings_usd || 0

  const onboardingSection = (
    <div className="space-y-8">
      <GuidanceSection storageKey="dashboard-overview" complete={isFirstRunComplete}>
        <ConceptPanel
          conceptId="workspace"
          icon={Building2}
          badgeKinds={['runtimeSupported', 'ossFixedRoles']}
        />

        <DocsLinkGroup
          links={[
            { label: t('onboarding.docs.quickstart'), href: repoDocsUrl('docs/QUICKSTART.md') },
            { label: t('onboarding.docs.concepts'), href: repoDocsUrl('docs/OSS_CONCEPTS.md') },
            { label: t('onboarding.docs.dashboard'), href: repoDocsUrl('docs/DASHBOARD.md') },
            { label: t('onboarding.docs.providers'), href: repoDocsUrl('docs/PROVIDER_CATALOG.md') },
            { label: t('onboarding.docs.namespaces'), href: repoDocsUrl('docs/NAMESPACES_AND_SHADOW.md') },
            { label: t('onboarding.docs.advanced'), href: repoDocsUrl('docs/SEMANTIC_PLATFORM.md') },
          ]}
        />
      </GuidanceSection>

      <Card className="animate-fade-up overflow-hidden">
        <CardHeader className={onboardingCollapsed ? 'pb-5' : undefined}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-muted)] text-[var(--accent)]">
                <PlayCircle className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0">
                <CardTitle>{t('onboarding.title')}</CardTitle>
                <Link to="/launchpad" className="text-xs underline text-[var(--accent)]">{t('launchpad.eyebrow')}</Link>
                <p className="mt-1 max-w-3xl text-[12px] font-medium leading-5 text-[var(--foreground-dim)]">
                  {onboardingCollapsed && isFirstRunComplete
                    ? t('onboarding.summary.complete')
                    : onboardingCollapsed && nextFirstRunStep
                      ? t('onboarding.summary.next', { step: nextFirstRunStep.title })
                      : t('onboarding.description')}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={isFirstRunComplete ? 'emerald' : 'amber'}>
                {t('onboarding.progress', {
                  completed: completedFirstRunSteps,
                  total: requiredFirstRunSteps.length,
                })}
              </Badge>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={toggleOnboarding}
                aria-expanded={!onboardingCollapsed}
                className="h-8 px-2.5"
              >
                {onboardingCollapsed ? (
                  <ChevronRight className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
                <span>
                  {onboardingCollapsed
                    ? t('onboarding.actions.showChecklist')
                    : t('onboarding.actions.hideChecklist')}
                </span>
              </Button>
            </div>
          </div>
        </CardHeader>
        <AnimatePresence initial={false}>
          {!onboardingCollapsed && (
            <motion.div
              key="onboarding-checklist"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <CardContent>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {firstRunSteps.map((step) => {
                    const StepIcon = step.icon
                    return (
                      <div
                        key={step.key}
                        className="flex min-h-[128px] flex-col justify-between rounded-lg bg-[var(--background-tertiary)] px-3.5 py-3"
                      >
                        <div className="space-y-3">
                          <div className="flex items-start justify-between gap-2">
                            <div
                              className={
                                step.done
                                  ? 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                  : 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--background-secondary)] text-[var(--foreground-dim)]'
                              }
                            >
                              <StepIcon className="h-4 w-4" />
                            </div>
                            <span
                              className={
                                step.done
                                  ? 'inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-300'
                                  : 'inline-flex items-center gap-1 rounded-md bg-[var(--background-secondary)] px-2 py-1 text-[10px] font-bold text-[var(--foreground-dim)]'
                              }
                            >
                              {step.done ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
                              {step.optional
                                ? t('onboarding.status.optional')
                                : step.done
                                  ? t('onboarding.status.done')
                                  : t('onboarding.status.todo')}
                            </span>
                          </div>
                          <div>
                            <div className="text-[13px] font-extrabold leading-5 text-[var(--foreground)]">
                              {step.title}
                            </div>
                            <div className="mt-1 text-[11px] font-medium leading-5 text-[var(--foreground-dim)]">
                              {step.description}
                            </div>
                          </div>
                        </div>
                        <Link
                          to={step.href}
                          className="mt-4 inline-flex items-center justify-between gap-2 rounded-lg bg-[var(--background-secondary)] px-3 py-2 text-[11px] font-bold text-[var(--foreground-muted)] transition-all hover:-translate-y-0.5 hover:text-[var(--foreground)] hover:shadow-[0_12px_28px_rgba(5,46,36,0.08)]"
                        >
                          <span className="min-w-0 truncate">{step.action}</span>
                          <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                        </Link>
                      </div>
                    )
                  })}
                </div>
                <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--background-secondary)] px-3 py-2 text-[11px] font-medium leading-5 text-[var(--foreground-dim)]">
                  {t('onboarding.privacy')}
                </div>
              </CardContent>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>
    </div>
  )

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.description')}
        icon={LayoutDashboard}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Select
            options={namespaceOptions}
            value={namespaceFilter}
            onChange={(v) => setNamespaceFilter(v)}
            className="w-44"
          />
          <Select
            options={apiKeyOptions}
            value={apiKeyFilter}
            onChange={(v) => setApiKeyFilter(v)}
            className="w-40"
          />
        </div>
      </PageHeader>

      {!isFirstRunComplete && onboardingSection}

      <GovernancePosture
        responseCacheEnabled={cacheStats ? cacheStats.enabled : undefined}
        privacy={
          privacyPosture
            ? {
                activeStores: privacyPosture.content_stores.filter((store) => store.enabled).map((store) => store.id),
                unreviewedPlugins: privacyPosture.plugins.unreviewed,
              }
            : undefined
        }
        activeKeyCount={apiKeysData ? apiKeyCount : undefined}
        blockedLast24h={denialSummary?.total}
        providerCount={configData ? configuredNodeCount : undefined}
        policyScopeCount={policyNamespaceCount}
        spend={
          budgetData === undefined
            ? undefined
            : topBudgetRule
              ? {
                  percentage: topBudgetRule.percentage,
                  type: topBudgetRule.type,
                  exceeded: topBudgetRule.exceeded,
                  alert: topBudgetRule.alert,
                }
              : null
        }
        runtime={
          clusterStatus
            ? {
                clustered: clusterStatus.enabled,
                instances: clusterStatus.instance_count ?? 1,
                sharedStateStatus: t(`cluster.redis.${clusterStatus.redis.status || 'disabled'}`),
                degraded: Boolean(clusterStatus.state?.degraded || clusterStatus.redis.status === 'error'),
                alertChannels: alertsData?.configured_channels ?? 0,
              }
            : undefined
        }
      />

      {/* Key metrics */}
      <div className="stagger-children grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={`${t('metrics.totalCalls')} (24h)`}
          value={formatNumber(total.calls)}
          subtitle={[
            t('metrics.successRate', { value: total.successRate.toFixed(1) }),
            ...(total.failed > 0 ? [t('metrics.failedCalls', { count: total.failed })] : []),
          ].join(' · ')}
          icon={Activity}
        />
        <MetricCard
          label={`${t('metrics.totalCost')} (24h)`}
          value={formatCost(total.costUsd)}
          subtitle={[
            t('metrics.tokensInOut', {
              input: formatTokens(total.inputTokens),
              output: formatTokens(total.outputTokens),
            }),
            ...(optimizerSavings > 0 ? [t('metrics.optimizerSaved', { cost: formatCost(optimizerSavings) })] : []),
          ].join(' · ')}
          icon={DollarSign}
        />
        <Card className="animate-fade-up relative overflow-hidden p-5">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(34,197,94,0.16),transparent_55%)]" />
          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <div className="text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
                {t('metrics.cacheSavings')}
              </div>
              <div
                className={
                  cacheComparisonAmount(cacheSavings?.summary, 'savings') == null
                    ? 'text-[29px] font-extrabold leading-none tracking-tight text-[var(--foreground-muted)]'
                    : Number(cacheComparisonAmount(cacheSavings?.summary, 'savings')) >= 0
                    ? 'text-[29px] font-extrabold leading-none tracking-tight text-emerald-700 dark:text-emerald-300'
                    : 'text-[29px] font-extrabold leading-none tracking-tight text-amber-700 dark:text-amber-300'
                }
              >
                {formatCacheCost(cacheComparisonAmount(cacheSavings?.summary, 'savings'))}
              </div>
              <div className="space-y-1">
                <div className="text-[11px] font-medium text-[var(--foreground-dim)]">
                  {t('metrics.cacheSavingsPercent', {
                    value: formatCacheRate(cacheSavings?.summary.savings_percentage),
                  })}
                </div>
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--foreground-dim)]">
                  {t('metrics.cacheSavingsHitRate', {
                    value: formatCacheRate(cacheSavings?.summary.cache_hit_rate),
                  })}
                </div>
              </div>
            </div>
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
              <TrendingDown className="h-5 w-5" />
            </div>
          </div>
          <CacheReferenceNotice data={cacheSavings} compact />
          <div className="relative mt-5 flex h-6 items-end gap-1">
            {[22, 36, 48, 64, 42, 72, 58, 78, 62].map((height, index) => (
              <div
                key={`cache-savings-${index}`}
                className="w-full rounded-full"
                style={{
                  height: index >= 5 ? `${height}%` : '3px',
                  background:
                    index >= 5 ? 'rgba(34,197,94,0.72)' : 'rgba(34,197,94,0.18)',
                }}
              />
            ))}
          </div>
        </Card>
        <MetricCard
          label={t('metrics.avgLatency')}
          value={formatLatency(total.avgLatencyMs)}
          subtitle={t('metrics.uniqueSessions', { count: formatNumber(total.uniqueSessions) })}
          icon={Clock}
        />
      </div>

      {/* Insights and governance health */}
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-5">
        <Card className="animate-fade-up xl:col-span-3" style={{ animationDelay: '80ms' }}>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>{t('insights.title')}</CardTitle>
                <p className="mt-1 text-[12px] font-medium text-[var(--foreground-dim)]">
                  {insightView === 'tiers' ? t('tierDistribution.description') : t('nodeDistribution.description')}
                </p>
              </div>
              <div role="group" aria-label={t('insights.title')} className="flex shrink-0 rounded-lg bg-[var(--background-tertiary)] p-1">
                {(['tiers', 'nodes'] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    aria-pressed={insightView === view}
                    onClick={() => setInsightView(view)}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors',
                      insightView === view
                        ? 'bg-[var(--background-secondary)] text-[var(--foreground)] shadow-[0_1px_2px_rgba(5,46,36,0.08)]'
                        : 'text-[var(--foreground-dim)] hover:text-[var(--foreground)]',
                    )}
                  >
                    {view === 'tiers' ? t('insights.tiers') : t('insights.nodes')}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {insightView === 'tiers' ? (
              <>
            {tierDistribution.length === 0 ? (
              <EmptyState
                icon={PieChartIcon}
                title={t('tierDistribution.emptyTitle')}
                description={t('tierDistribution.emptyDescription')}
                className="py-8"
              />
            ) : (
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
                <div className="relative mx-auto h-[230px] w-[260px] shrink-0">
                  <PieChart width={260} height={230}>
                    <Pie
                      data={tierDistribution}
                      cx="50%"
                      cy="50%"
                      innerRadius={66}
                      outerRadius={92}
                      dataKey="count"
                      nameKey="tier"
                      stroke="var(--background-secondary)"
                      strokeWidth={5}
                      paddingAngle={4}
                      cornerRadius={8}
                      onMouseLeave={() => setActiveTier(null)}
                    >
                      {tierDistribution.map((entry) => (
                        <Cell
                          key={entry.tier}
                          fill={TIER_CHART_COLORS[entry.tier] ?? '#7B8F89'}
                          opacity={!activeTier || activeTier === entry.tier ? 1 : 0.34}
                          onMouseEnter={() => setActiveTier(entry.tier)}
                        />
                      ))}
                    </Pie>
                    <RechartsTooltip content={<SignalTooltip />} />
                  </PieChart>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <div className="font-mono text-[24px] font-extrabold text-[var(--foreground)]">
                      {formatNumber(totalTierCalls)}
                    </div>
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">
                      {t('tierDistribution.routed')}
                    </div>
                  </div>
                </div>
                <div className="min-w-[150px] space-y-2.5">
                  {tierDistribution.map((entry) => {
                    const color = TIER_CHART_COLORS[entry.tier] ?? '#7B8F89'
                    const pct = totalTierCalls > 0 ? (entry.count / totalTierCalls) * 100 : 0

                    return (
                      <button
                        key={entry.tier}
                        type="button"
                        onMouseEnter={() => setActiveTier(entry.tier)}
                        onMouseLeave={() => setActiveTier(null)}
                        className="w-full rounded-lg bg-[var(--background-tertiary)] px-3 py-2 text-left transition-all hover:-translate-y-0.5 hover:bg-white hover:shadow-[0_12px_30px_rgba(5,46,36,0.08)]"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="flex items-center gap-2 text-xs font-bold capitalize text-[var(--foreground-muted)]">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                            {entry.tier}
                          </span>
                          <span className="font-mono text-xs font-bold text-[var(--foreground)]">
                            {formatNumber(entry.count)}
                          </span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--progress-track)]">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${pct}%`, background: color }}
                          />
                        </div>
                      </button>
                    )
                  })}
                  {promptCacheCount > 0 && (
                    <div className="rounded-lg border border-emerald-500/15 bg-emerald-500/5 px-3 py-2 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                      {t('cache.callsHidden', { count: formatNumber(promptCacheCount) })}
                    </div>
                  )}
                </div>
              </div>
            )}
              </>
            ) : (
              <>
                <div className="mb-3 flex items-center justify-end gap-4 text-[11px] font-bold text-[var(--foreground-dim)]">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[var(--chart-blue)]" />
                    {t('chart.legend.calls')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-[var(--chart-orange)]" />
                    {t('chart.legend.latency')}
                  </span>
                </div>
            {nodeDistribution.length === 0 ? (
              <EmptyState
                icon={BarChart3}
                title={t('nodeDistribution.emptyTitle')}
                description={t('nodeDistribution.emptyDescription')}
                className="py-8"
              />
            ) : (
              <>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={nodeDistribution} barGap={8} margin={{ top: 12, right: 8, left: 6, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke={colors.chartAxisLine} strokeDasharray="4 8" />
                    <XAxis
                      dataKey="nodeId"
                      tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="calls"
                      tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                      axisLine={false}
                      tickLine={false}
                      width={58}
                      tickFormatter={(value: number) => formatNumber(value)}
                    />
                    <YAxis yAxisId="latency" orientation="right" hide />
                    <RechartsTooltip content={<SignalTooltip />} cursor={{ fill: 'rgba(22, 184, 142, 0.06)' }} />
                    <Bar yAxisId="calls" dataKey="count" radius={[8, 8, 0, 0]} barSize={24}>
                      {nodeDistribution.map((entry) => (
                        <Cell
                          key={entry.nodeId}
                          fill={getNodeColor(entry.nodeId)}
                          opacity={!activeNode || activeNode === entry.nodeId ? 1 : 0.42}
                          onMouseEnter={() => setActiveNode(entry.nodeId)}
                          onMouseLeave={() => setActiveNode(null)}
                        />
                      ))}
                    </Bar>
                    <Bar
                      yAxisId="latency"
                      dataKey="avgLatencyMs"
                      radius={[8, 8, 0, 0]}
                      barSize={18}
                      fill="var(--chart-orange)"
                      opacity={0.82}
                    />
                  </BarChart>
                </ResponsiveContainer>
                <div className="mt-5 grid gap-2 sm:grid-cols-2">
                  {nodeDistribution.slice(0, 4).map((entry) => {
                    const color = getNodeColor(entry.nodeId)
                    return (
                      <div
                        key={entry.nodeId}
                        className="rounded-lg bg-[var(--background-tertiary)] px-3 py-2.5 transition-all hover:-translate-y-0.5 hover:bg-white hover:shadow-[0_12px_30px_rgba(5,46,36,0.08)]"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="truncate font-mono text-[11px] font-bold text-[var(--foreground)]">
                            {entry.nodeId}
                          </span>
                          <span className="font-mono text-[11px] text-[var(--foreground-dim)]">
                            {formatLatency(entry.avgLatencyMs)}
                          </span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--progress-track)]">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${(entry.count / maxNodeCalls) * 100}%`, background: color }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
              </>
            )}
          </CardContent>
        </Card>

        <div className="xl:col-span-2">
          <Card className="animate-fade-up" style={{ animationDelay: '120ms' }}>
            <CardHeader>
              <div>
                <CardTitle>{t('governanceHealth.title')}</CardTitle>
                <p className="mt-1 text-[12px] font-medium text-[var(--foreground-dim)]">
                  {t('governanceHealth.description')}
                </p>
              </div>
            </CardHeader>
            <CardContent className="divide-y divide-[var(--border)]">
              <HealthSection
                icon={setupWarnings.length > 0 ? AlertTriangle : CheckCircle2}
                tone={setupWarnings.length > 0 ? 'attention' : 'good'}
                title={t('configHealth.title')}
              >
                <div className="text-[12px] font-medium leading-5 text-[var(--foreground-dim)]">
                  {setupWarnings.length > 0
                    ? t('configHealth.needsAttention', { count: setupWarnings.length })
                    : t('configHealth.ready')}
                </div>
                {setupWarnings.slice(0, 3).map((warning) => (
                  <div key={warning} className="text-[11px] leading-5 text-amber-700 dark:text-amber-300">
                    {warning}
                  </div>
                ))}
                <div className="grid grid-cols-3 gap-2">
                  <MiniStat label={t('configHealth.upstreams')} value={configData?.nodes.length ?? '-'} />
                  <MiniStat label={t('configHealth.clientKeys')} value={apiKeysData?.items.length ?? '-'} />
                  <MiniStat label={t('configHealth.diagnostics')} value={configDiagnostics.length} />
                </div>
              </HealthSection>

              <HealthSection
                icon={ShieldCheck}
                tone={guardrailsData?.enabled ? 'good' : 'neutral'}
                title={t('guardrails.title')}
                aside={
                  <Badge variant={guardrailsData?.enabled ? 'emerald' : 'zinc'}>
                    {guardrailsData?.enabled ? t('guardrails.enabled') : t('guardrails.disabled')}
                  </Badge>
                }
              >
                <div className="grid grid-cols-2 gap-2">
                  <MiniStat label={t('guardrails.findings')} value={guardrailsData?.findings.total ?? 0} />
                  <MiniStat
                    label={t('guardrails.webhook')}
                    value={
                      guardrailsData?.webhook.enabled
                        ? t(`guardrails.webhookStatus.${guardrailsData.webhook.last_status || 'queued'}`)
                        : guardrailsData?.webhook.configured
                          ? t('guardrails.webhookConfigured')
                          : t('guardrails.webhookOff')
                    }
                  />
                </div>
                {!guardrailsData || guardrailsData.findings.recent.length === 0 ? (
                  <div className="text-[12px] text-[var(--foreground-dim)]">
                    {guardrailsData?.enabled ? t('guardrails.empty') : t('guardrails.notConfigured')}
                  </div>
                ) : (
                  guardrailsData.findings.recent.slice(0, 2).map((finding, index) => (
                    <div
                      key={`${finding.request_id || 'finding'}-${finding.rule}-${index}`}
                      className="flex items-center justify-between gap-3 rounded-lg bg-[var(--background-tertiary)] px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-[var(--foreground)]">{finding.rule}</div>
                        <div className="truncate font-mono text-[11px] text-[var(--foreground-dim)]">
                          {finding.kind} · {t('guardrails.matches', { count: finding.match_count ?? 1 })}
                        </div>
                      </div>
                      <span className={guardrailActionClass(finding.action)}>{t(`guardrails.actions.${finding.action}`)}</span>
                    </div>
                  ))
                )}
                {guardrailsData?.webhook.last_error && (
                  <div className="truncate text-[11px] text-red-700 dark:text-red-300">
                    {t('guardrails.lastWebhookError')}: {guardrailsData.webhook.last_error}
                  </div>
                )}
              </HealthSection>

              <HealthSection
                icon={BellRing}
                tone={alertsData?.enabled ? 'good' : 'neutral'}
                title={t('alerts.title')}
                aside={
                  <div className="flex items-center gap-2">
                    <Link to="/alerts" className="text-xs font-semibold text-[var(--accent)] underline-offset-4 hover:underline">
                      {t('alerts.configure')}
                    </Link>
                    <Badge variant={alertsData?.enabled ? 'emerald' : 'zinc'}>
                      {alertsData?.enabled ? t('alerts.enabled') : t('alerts.disabled')}
                    </Badge>
                  </div>
                }
              >
                <div className="grid grid-cols-2 gap-2">
                  <MiniStat label={t('alerts.channels')} value={alertsData?.configured_channels ?? 0} />
                  <MiniStat label={t('alerts.recent')} value={alertsData?.recent.length ?? 0} />
                </div>
                {!alertsData || alertsData.recent.length === 0 ? (
                  <div className="text-[12px] text-[var(--foreground-dim)]">
                    {alertsData?.enabled ? t('alerts.empty') : t('alerts.notConfigured')}
                  </div>
                ) : (
                  alertsData.recent.slice(0, 2).map((alert) => (
                    <div
                      key={alert.id}
                      className="flex items-center justify-between gap-3 rounded-lg bg-[var(--background-tertiary)] px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-[var(--foreground)]">{alert.message}</div>
                        <div className="truncate font-mono text-[11px] text-[var(--foreground-dim)]">
                          {formatTimestamp(alert.timestamp)} · {alert.event}
                        </div>
                      </div>
                      <span className={alertStatusClass(alert.status)}>{t(`alerts.status.${alert.status}`)}</span>
                    </div>
                  ))
                )}
              </HealthSection>

              <HealthSection
                icon={Network}
                tone={clusterStatus?.state?.degraded || clusterStatus?.redis.status === 'error' ? 'attention' : 'good'}
                title={t('cluster.title')}
                aside={
                  <div className="flex items-center gap-2">
                    <Badge variant={clusterStatus?.enabled ? 'emerald' : 'zinc'}>
                      {clusterStatus?.enabled ? t('cluster.mode.cluster') : t('cluster.mode.single')}
                    </Badge>
                    <Badge
                      variant={
                        clusterStatus?.redis.status === 'ready'
                          ? 'emerald'
                          : clusterStatus?.redis.status === 'error'
                            ? 'red'
                            : 'zinc'
                      }
                    >
                      {t(`cluster.redis.${clusterStatus?.redis.status || 'disabled'}`)}
                    </Badge>
                  </div>
                }
              >
                <div className="grid grid-cols-3 gap-2">
                  <MiniStat label={t('cluster.instances')} value={clusterStatus?.instance_count ?? 1} />
                  <MiniStat label={t('cluster.state')} value={clusterStatus?.state?.backend || 'memory'} />
                  <MiniStat label={t('cluster.shared')} value={`${sharedCategoryCount}/${stateCategories.length || 8}`} />
                </div>
                {clusterStatus?.state?.degraded || clusterStatus?.redis.last_error ? (
                  <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-5 text-amber-700 dark:text-amber-300">
                    {clusterStatus.redis.last_error || clusterStatus.state?.last_error || t('cluster.degraded')}
                  </div>
                ) : (
                  <div className="text-[11px] font-medium text-[var(--foreground-dim)]">
                    {clusterStatus?.enabled ? t('cluster.ready') : t('cluster.singleReady')}
                  </div>
                )}
              </HealthSection>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Cache Status */}
      {cacheStats?.enabled && (
        <Card className="animate-fade-up" style={{ animationDelay: '160ms' }}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-[var(--accent)]" />
                <CardTitle>{t('cache.title')}</CardTitle>
              </div>
              <button
                onClick={() => clearCache.mutate()}
                disabled={clearCache.isPending || cacheStats.entries === 0}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--background-tertiary)] px-3 py-1.5 text-xs font-medium text-[var(--foreground-muted)] transition-all hover:-translate-y-0.5 hover:text-[var(--foreground)] hover:shadow-[0_12px_28px_rgba(5,46,36,0.08)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 className="h-3 w-3" />
                {t('cache.clear')}
              </button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <div className="rounded-lg bg-[var(--background-tertiary)] p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--foreground-dim)]">
                  {t('cache.hitRate')}
                </p>
                <p className="font-mono text-xl font-bold text-[var(--foreground)]">
                  {cacheStats.hitRate}%
                </p>
              </div>
              <div className="rounded-lg bg-[var(--background-tertiary)] p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--foreground-dim)]">
                  {t('cache.hits')}
                </p>
                <p className="font-mono text-xl font-bold text-emerald-600 dark:text-emerald-400">
                  {formatNumber(cacheStats.hits)}
                </p>
              </div>
              <div className="rounded-lg bg-[var(--background-tertiary)] p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--foreground-dim)]">
                  {t('cache.misses')}
                </p>
                <p className="font-mono text-xl font-bold text-[var(--foreground-muted)]">
                  {formatNumber(cacheStats.misses)}
                </p>
              </div>
              <div className="rounded-lg bg-[var(--background-tertiary)] p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--foreground-dim)]">
                  {t('cache.entries')}
                </p>
                <p className="font-mono text-xl font-bold text-[var(--foreground)]">
                  {cacheStats.entries}
                  <span className="text-xs font-normal text-[var(--foreground-dim)]">
                    {' '}/ {cacheStats.maxEntries}
                  </span>
                </p>
              </div>
              <div className="rounded-lg bg-[var(--background-tertiary)] p-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--foreground-dim)]">
                  {t('cache.memory')}
                </p>
                <p className="font-mono text-xl font-bold text-[var(--foreground)]">
                  {cacheStats.memoryMb} MB
                </p>
              </div>
            </div>
            {/* Hit rate progress bar */}
            <div className="mt-4">
              <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--progress-track)]">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${Math.min(cacheStats.hitRate, 100)}%`,
                    background: 'var(--accent)',
                  }}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent traffic (SSE) */}
      <Card className="animate-fade-up" style={{ animationDelay: '320ms' }}>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CardTitle>{t('recentCalls.title')}</CardTitle>
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-40" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
              </span>
            </div>
            <span className="rounded-md border border-[var(--sse-border)] bg-[var(--sse-bg)] px-2 py-1 text-[10px] font-bold text-[var(--sse-text)]">
              {t('recentCalls.live')}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {recentLogs.length === 0 ? (
            <div className="flex h-24 items-center justify-center rounded-lg bg-[var(--background-tertiary)] text-sm text-[var(--foreground-dim)]">
              {t('recentCalls.waiting')}
            </div>
          ) : (
            <div className="space-y-2">
              <AnimatePresence mode="popLayout">
                {recentLogs.map((log) => (
                  <motion.div
                    key={log.id}
                    initial={{ opacity: 0, y: -8, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 8, scale: 0.98 }}
                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                    className="grid grid-cols-[92px_auto_1fr_auto_auto_auto_auto] items-center gap-3 rounded-lg bg-[var(--background-tertiary)] px-3.5 py-2.5 text-xs transition-all hover:-translate-y-0.5 hover:bg-white hover:shadow-[0_12px_30px_rgba(5,46,36,0.08)]"
                  >
                    <span className="font-mono text-[var(--foreground-dim)]">
                      {formatTimestamp(log.timestamp)}
                    </span>
                    {isPromptCacheLog(log) ? (
                      <Badge variant="emerald">{t('cache.hit')}</Badge>
                    ) : (
                      <TierBadge tier={log.tier} />
                    )}
                    <div className="min-w-0">
                      <span className="font-semibold text-[var(--foreground-muted)]">
                        {isPromptCacheLog(log) ? t('cache.noUpstream') : log.node_id}
                      </span>
                      <Tooltip content={log.model}>
                        <span className="ml-2 inline-block max-w-[180px] truncate align-bottom font-mono text-[var(--foreground-dim)]">
                          {log.model}
                        </span>
                      </Tooltip>
                    </div>
                    <span className="font-mono text-[var(--foreground-dim)]">
                      {t('recentCalls.tokens', { count: formatTokens(log.input_tokens + log.output_tokens) })}
                    </span>
                    <span className="font-mono text-[var(--foreground-dim)]">
                      {formatLatency(log.latency_ms)}
                    </span>
                    <span
                      className={
                        log.status_code === 200
                          ? 'rounded-md bg-emerald-500/10 px-2 py-1 font-mono font-bold text-emerald-700 dark:text-emerald-300'
                          : 'rounded-md bg-red-500/10 px-2 py-1 font-mono font-bold text-red-700 dark:text-red-300'
                      }
                    >
                      {log.status_code}
                    </span>
                    {isPromptCacheLog(log) ? (
                      <span />
                    ) : (
                      <span className="flex items-center gap-1">
                        <Tooltip content={t('recentCalls.routeDecision')}>
                          <Link
                            to={`/route-decisions/${encodeURIComponent(log.request_id)}`}
                            aria-label={t('recentCalls.routeDecision')}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--foreground-dim)] transition-colors hover:bg-[var(--background-secondary)] hover:text-[var(--accent)]"
                          >
                            <RouteIcon className="h-3.5 w-3.5" />
                          </Link>
                        </Tooltip>
                        <Tooltip content={t('recentCalls.costDetail')}>
                          <Link
                            // Write-behind logging can stream a row before its database id exists.
                            to={typeof log.id === 'number' ? `/logs/${log.id}/cost` : '/logs'}
                            aria-label={t('recentCalls.costDetail')}
                            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--foreground-dim)] transition-colors hover:bg-[var(--background-secondary)] hover:text-[var(--accent)]"
                          >
                            <CircleDollarSign className="h-3.5 w-3.5" />
                          </Link>
                        </Tooltip>
                      </span>
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </CardContent>
      </Card>

      {isFirstRunComplete && onboardingSection}
    </div>
  )
}

function HealthSection({
  icon: Icon,
  tone,
  title,
  aside,
  children,
}: {
  icon: LucideIcon
  tone: 'good' | 'attention' | 'neutral'
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-2.5 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            aria-hidden="true"
            className={cn(
              'h-4 w-4 shrink-0',
              tone === 'attention' ? 'text-[var(--warning)]' : tone === 'good' ? 'text-[var(--accent)]' : 'text-[var(--foreground-dim)]',
            )}
          />
          <h3 className="truncate text-[13px] font-extrabold text-[var(--foreground)]">{title}</h3>
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

function MiniStat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg bg-[var(--background-tertiary)] px-3 py-2">
      <div className="truncate text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--foreground-dim)]">{label}</div>
      <div className="mt-1 truncate font-mono text-[13px] font-extrabold text-[var(--foreground)]">{value}</div>
    </div>
  )
}

function guardrailActionClass(action: string) {
  const base = 'w-fit shrink-0 rounded-md px-2 py-1 font-mono font-bold'
  if (action === 'block') return `${base} bg-red-500/10 text-red-700 dark:text-red-300`
  if (action === 'redact') return `${base} bg-amber-500/10 text-amber-700 dark:text-amber-300`
  if (action === 'webhook') return `${base} bg-blue-500/10 text-blue-700 dark:text-blue-300`
  return `${base} bg-[var(--background-secondary)] text-[var(--foreground-dim)]`
}

function alertStatusClass(status: string) {
  const base = 'w-fit shrink-0 rounded-md px-2 py-1 font-mono font-bold'
  if (status === 'sent') return `${base} bg-emerald-500/10 text-emerald-700 dark:text-emerald-300`
  if (status === 'failed') return `${base} bg-red-500/10 text-red-700 dark:text-red-300`
  return `${base} bg-[var(--background-secondary)] text-[var(--foreground-dim)]`
}

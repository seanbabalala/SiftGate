import { CacheReferenceNotice, CacheBreakdownUnavailable } from '@/components/pricing/cache-reference-notice'
import { cacheComparisonAmount, formatCacheMoney, formatCachePercent } from '@/lib/cache-reference-display'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts'
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  Coins,
  Zap,
  Database,
  BarChart3 as BarChart3Icon,
  PieChart as PieChartIcon,
} from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { MetricCard } from '@/components/shared/MetricCard'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { SkeletonCard, SkeletonChart, Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { useCostAnalytics } from '@/hooks/use-analytics'
import { useApiKeys } from '@/hooks/use-api-keys'
import { useCacheSavings } from '@/hooks/use-cache-savings'
import { useThemeColors } from '@/lib/theme'
import {
  formatCost,
  formatNumber,
  formatTokens,
  formatLatency,
  formatPercent,
  getNodeColor,
  TIER_CHART_COLORS,
} from '@/lib/utils'

const MODEL_COLORS = [
  '#064B3A', '#4867E8', '#D9872F', '#7446C6', '#CC3C7E',
  '#189AA8', '#B86B2B', '#8B6AD6', '#287F8C', '#4E756A',
]
const CACHE_STACK_COLORS = {
  normal: '#0F766E',
  read: '#10B981',
  write: '#F59E0B',
  output: '#475569',
}

function compactChartLabel(value: string, max = 22) {
  if (!value) return ''
  if (value.length <= max) return value
  const head = Math.max(8, Math.floor((max - 3) * 0.58))
  const tail = Math.max(5, max - 3 - head)
  return `${value.slice(0, head)}...${value.slice(-tail)}`
}

export function AnalyticsPage() {
  const { t, i18n } = useTranslation('analytics')
  const formatCacheCost = (value: number | string | null | undefined) => formatCacheMoney(value, i18n.resolvedLanguage ?? i18n.language)
  const formatCacheRate = (value: number | null | undefined) => formatCachePercent(value, i18n.resolvedLanguage ?? i18n.language)
  const [period, setPeriod] = useState('7d')
  const [apiKeyFilter, setApiKeyFilter] = useState('')
  const { data, isLoading, isError, error, refetch } = useCostAnalytics(
    period,
    apiKeyFilter ? { id: apiKeyFilter } : undefined,
  )
  const { data: apiKeysData } = useApiKeys()
  const {
    data: providerCacheByNode,
    isLoading: cacheNodeLoading,
  } = useCacheSavings(period, 'node', apiKeyFilter ? { id: apiKeyFilter } : undefined)
  const {
    data: providerCacheByModel,
    isLoading: cacheModelLoading,
  } = useCacheSavings(period, 'model', apiKeyFilter ? { id: apiKeyFilter } : undefined)
  const colors = useThemeColors()
  const periodOptions = [
    { value: '7d', label: t('filters.days', { count: 7 }) },
    { value: '30d', label: t('filters.days', { count: 30 }) },
    { value: '90d', label: t('filters.days', { count: 90 }) },
  ]

  const apiKeyOptions = [
    { value: '', label: t('filters.allApiKeys') },
    ...(apiKeysData?.items || []).map((key) => ({ value: key.id, label: key.name })),
  ]

  if (isError) {
    return <ErrorState error={error} onRetry={refetch} />
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('analytics.title')} description={t('analytics.description')} />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
        <div className="glass-card-static rounded-2xl p-6">
          <Skeleton className="h-4 w-40 mb-4" />
          <SkeletonChart height={280} />
        </div>
      </div>
    )
  }

  const tooltipStyle = {
    background: colors.chartTooltipBg,
    border: `1px solid ${colors.chartTooltipBorder}`,
    borderRadius: '8px',
    fontSize: '12px',
    padding: '8px 12px',
    boxShadow: '0 22px 52px rgba(5,46,36,0.16)',
  }
  const cachePanelReady =
    providerCacheByNode &&
    providerCacheByModel &&
    providerCacheByNode.summary.provider_routed_requests > 0
  const cachePeriodDays = providerCacheByNode?.period_days || data.period

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('analytics.title')}
        description={t('analytics.description')}
        icon={BarChart3Icon}
      >
        <div className="flex items-center gap-3">
          <Select
            options={apiKeyOptions}
            value={apiKeyFilter}
            onChange={(v) => setApiKeyFilter(v)}
            className="w-40"
          />
          <div className="flex items-center gap-1 rounded-lg bg-[var(--background-secondary)] p-1 shadow-[0_1px_2px_rgba(5,46,36,0.05)]">
            {periodOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition-all ${
                  period === opt.value
                    ? 'bg-[var(--accent)] text-[var(--accent-foreground)] shadow-sm'
                    : 'text-[var(--foreground-dim)] hover:text-[var(--foreground)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </PageHeader>

      {/* Summary Metrics */}
      <div className="stagger-children grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <MetricCard
          label={t('metrics.totalCost')}
          value={formatCost(data.total.cost)}
          subtitle={t('metrics.period', { count: data.period })}
          icon={DollarSign}
        />
        <MetricCard
          label={t('metrics.totalCalls')}
          value={formatNumber(data.total.calls)}
          subtitle={t('metrics.avgCostPerCall', { cost: formatCost(data.total.avgCostPerCall) })}
          icon={Zap}
        />
        <MetricCard
          label={t('metrics.inputTokens')}
          value={formatTokens(data.total.inputTokens)}
          subtitle={t('metrics.totalTokens', { total: formatTokens(data.total.inputTokens + data.total.outputTokens) })}
          icon={Coins}
        />
        <MetricCard
          label={t('metrics.outputTokens')}
          value={formatTokens(data.total.outputTokens)}
          subtitle={t('metrics.percentOfTotal', {
            value: ((data.total.outputTokens / Math.max(1, data.total.inputTokens + data.total.outputTokens)) * 100).toFixed(0),
          })}
          icon={TrendingUp}
        />
      </div>

      {/* Daily Cost Trend */}
      <Card className="animate-fade-up" style={{ animationDelay: '100ms' }}>
        <CardHeader>
          <CardTitle>{t('dailyTrend.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.dailyTrend.length === 0 ? (
            <EmptyState icon={TrendingUp} title={t('dailyTrend.emptyTitle')} description={t('dailyTrend.emptyDescription')} className="py-8" />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={data.dailyTrend}>
                <defs>
                  <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.16} />
                    <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={colors.chartAxisLine}
                  opacity={0.3}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                  axisLine={{ stroke: colors.chartAxisLine }}
                  tickLine={false}
                  tickFormatter={(v: string) => {
                    const d = new Date(v)
                    return `${d.getMonth() + 1}/${d.getDate()}`
                  }}
                />
                <YAxis
                  tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                  axisLine={false}
                  tickLine={false}
                  width={50}
                  tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  itemStyle={{ color: colors.chartTooltipText }}
                  labelStyle={{ color: colors.chartTooltipText, fontWeight: 600, marginBottom: 4 }}
                  formatter={(value: number, name: string) => {
                    if (name === 'cost') return [formatCost(value), t('labels.cost')]
                    if (name === 'calls') return [value, t('labels.calls')]
                    return [value, name]
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="cost"
                  stroke="var(--accent)"
                  strokeWidth={2.5}
                  fill="url(#costGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Cost by Model + Cost by Node */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Cost Distribution Pie (by Model) */}
        <Card className="animate-fade-up" style={{ animationDelay: '160ms' }}>
          <CardHeader>
            <CardTitle>{t('byModel.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.byModel.length === 0 ? (
              <EmptyState icon={PieChartIcon} title={t('byModel.emptyTitle')} description={t('byModel.emptyDescription')} className="py-8" />
            ) : (
              <div className="flex items-center gap-4">
                <ResponsiveContainer width="55%" height={200}>
                  <PieChart>
                    <Pie
                      data={data.byModel}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      dataKey="cost"
                      nameKey="model"
                      stroke="var(--background-secondary)"
                      strokeWidth={5}
                      paddingAngle={4}
                      cornerRadius={8}
                    >
                      {data.byModel.map((_entry, i) => (
                        <Cell key={i} fill={MODEL_COLORS[i % MODEL_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={tooltipStyle}
                      itemStyle={{ color: colors.chartTooltipText }}
                      formatter={(value: number) => [formatCost(value), t('labels.cost')]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-2">
                  {data.byModel.slice(0, 6).map((item, i) => (
                    <div key={item.model} className="flex items-center gap-2">
                      <div
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          background: MODEL_COLORS[i % MODEL_COLORS.length],
                          boxShadow: `0 0 8px ${MODEL_COLORS[i % MODEL_COLORS.length]}40`,
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--foreground-muted)]">
                        {item.model}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] font-semibold text-[var(--foreground)]">
                        {formatCost(item.cost)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Cost by Node Bar Chart */}
        <Card className="animate-fade-up" style={{ animationDelay: '220ms' }}>
          <CardHeader>
            <CardTitle>{t('byNode.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.byNode.length === 0 ? (
              <EmptyState icon={BarChart3Icon} title={t('byNode.emptyTitle')} description={t('byNode.emptyDescription')} className="py-8" />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={data.byNode}>
                  <CartesianGrid
                    vertical={false}
                    stroke={colors.chartAxisLine}
                    strokeDasharray="4 8"
                  />
                  <XAxis
                    dataKey="nodeId"
                    tick={{ fill: colors.chartAxisTick, fontSize: 11, fontFamily: 'IBM Plex Mono' }}
                    axisLine={{ stroke: colors.chartAxisLine }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                    axisLine={false}
                    tickLine={false}
                    width={50}
                    tickFormatter={(v: number) => `$${v.toFixed(1)}`}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    itemStyle={{ color: colors.chartTooltipText }}
                    formatter={(value: number, name: string) => {
                      if (name === 'cost') return [formatCost(value), t('labels.cost')]
                      return [value, name]
                    }}
                  />
                  <Bar dataKey="cost" radius={[8, 8, 0, 0]} barSize={26}>
                    {data.byNode.map((entry) => (
                      <Cell
                        key={entry.nodeId}
                        fill={getNodeColor(entry.nodeId || '')}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cost by Tier */}
      <Card className="animate-fade-up" style={{ animationDelay: '280ms' }}>
        <CardHeader>
          <CardTitle>{t('byTier.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byTier.length === 0 ? (
            <EmptyState icon={Coins} title={t('byTier.emptyTitle')} description={t('byTier.emptyDescription')} className="py-6" />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {data.byTier.map((tierItem) => (
                <div
                  key={tierItem.tier}
                  className="rounded-lg bg-[var(--background-tertiary)] p-4"
                >
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-[var(--foreground-dim)]">
                    {tierItem.tier}
                  </div>
                  <div className="text-xl font-semibold tracking-tight text-[var(--foreground)]"
                    style={{ color: TIER_CHART_COLORS[tierItem.tier || ''] }}
                  >
                    {formatCost(tierItem.cost)}
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-[var(--foreground-dim)]">
                    {t('byTier.callsTokens', {
                      calls: formatNumber(tierItem.calls),
                      tokens: formatTokens(tierItem.inputTokens + tierItem.outputTokens),
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="animate-fade-up overflow-hidden" style={{ animationDelay: '320ms' }}>
        <CardHeader>
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle>{t('cache.title')}</CardTitle>
              <div className="mt-1 text-sm text-[var(--foreground-dim)]">
                {t('cache.description', { count: cachePeriodDays })}
              </div>
            </div>
            <div className="rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
              {t('cache.badge')}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <CacheReferenceNotice data={providerCacheByNode} />
          {cacheNodeLoading || cacheModelLoading ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <SkeletonCard key={`cache-metric-${index}`} />
                ))}
              </div>
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <SkeletonChart height={260} />
                <SkeletonChart height={260} />
              </div>
            </div>
          ) : !cachePanelReady ? (
            <EmptyState
              icon={Database}
              title={t('cache.emptyTitle')}
              description={t('cache.emptyDescription')}
              className="py-8"
            />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                <MetricCard
                  label={t('cache.metrics.saved')}
                  value={formatCacheCost(cacheComparisonAmount(providerCacheByNode.summary, 'savings'))}
                  subtitle={t('cache.metrics.savedPercent', {
                    value: formatCacheRate(providerCacheByNode.summary.savings_percentage),
                  })}
                  icon={TrendingDown}
                />
                <MetricCard
                  label={t('cache.metrics.hitRate')}
                  value={formatCacheRate(providerCacheByNode.summary.cache_hit_rate)}
                  subtitle={t('cache.metrics.hitRequests', {
                    hits: formatNumber(providerCacheByNode.summary.requests_with_provider_cache_hit),
                    total: formatNumber(providerCacheByNode.summary.cache_eligible_requests),
                  })}
                  icon={Zap}
                />
                <MetricCard
                  label={t('cache.metrics.withoutCache')}
                  value={formatCacheCost(cacheComparisonAmount(providerCacheByNode.summary, 'reference'))}
                  subtitle={t('cache.metrics.withCache', {
                    value: formatCacheCost(cacheComparisonAmount(providerCacheByNode.summary, 'actual')),
                  })}
                  icon={DollarSign}
                />
                <MetricCard
                  label={t('cache.metrics.cacheReadTokens')}
                  value={formatTokens(providerCacheByNode.summary.total_cache_read_tokens)}
                  subtitle={t('cache.metrics.cacheWriteTokens', {
                    value: formatTokens(providerCacheByNode.summary.total_cache_creation_tokens),
                  })}
                  icon={Coins}
                />
              </div>

              <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <Card className="border border-emerald-500/12 bg-[linear-gradient(180deg,rgba(16,185,129,0.06),transparent)]">
                  <CardHeader>
                    <CardTitle>{t('cache.trend.title')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={260}>
                      <AreaChart data={providerCacheByNode.daily_trend}>
                        <defs>
                          <linearGradient id="cacheSavingsGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={CACHE_STACK_COLORS.read} stopOpacity={0.22} />
                            <stop offset="95%" stopColor={CACHE_STACK_COLORS.read} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} stroke={colors.chartAxisLine} strokeDasharray="4 8" />
                        <XAxis
                          dataKey="date"
                          tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                          axisLine={{ stroke: colors.chartAxisLine }}
                          tickLine={false}
                          tickFormatter={(value: string) => {
                            const dateValue = new Date(value)
                            return `${dateValue.getMonth() + 1}/${dateValue.getDate()}`
                          }}
                        />
                        <YAxis
                          tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                          axisLine={false}
                          tickLine={false}
                          width={56}
                          tickFormatter={(value: number) => `$${value.toFixed(2)}`}
                        />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          itemStyle={{ color: colors.chartTooltipText }}
                          formatter={(value: number, name: string) => {
                            if (name === 'savings_usd') return [formatCost(value), t('cache.labels.saved')]
                            if (name === 'actual_cost_usd') return [formatCost(value), t('cache.labels.withCache')]
                            return [value, name]
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="savings_usd"
                          stroke={CACHE_STACK_COLORS.read}
                          strokeWidth={2.5}
                          fill="url(#cacheSavingsGradient)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>{t('cache.hitRateTrend.title')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={260}>
                      <AreaChart data={providerCacheByNode.daily_trend}>
                        <defs>
                          <linearGradient id="cacheHitGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={CACHE_STACK_COLORS.normal} stopOpacity={0.22} />
                            <stop offset="95%" stopColor={CACHE_STACK_COLORS.normal} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} stroke={colors.chartAxisLine} strokeDasharray="4 8" />
                        <XAxis
                          dataKey="date"
                          tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                          axisLine={{ stroke: colors.chartAxisLine }}
                          tickLine={false}
                          tickFormatter={(value: string) => {
                            const dateValue = new Date(value)
                            return `${dateValue.getMonth() + 1}/${dateValue.getDate()}`
                          }}
                        />
                        <YAxis
                          tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                          axisLine={false}
                          tickLine={false}
                          width={48}
                          tickFormatter={(value: number) => `${value.toFixed(0)}%`}
                        />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          itemStyle={{ color: colors.chartTooltipText }}
                          formatter={(value: number) => [formatPercent(value), t('cache.labels.hitRate')]}
                        />
                        <Area
                          type="monotone"
                          dataKey="cache_hit_rate"
                          stroke={CACHE_STACK_COLORS.normal}
                          strokeWidth={2.5}
                          fill="url(#cacheHitGradient)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>

              <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>{t('cache.byProvider.title')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart
                        data={providerCacheByNode.groups.slice(0, 6)}
                        layout="vertical"
                        margin={{ top: 4, right: 18, left: 4, bottom: 4 }}
                      >
                        <CartesianGrid horizontal={false} stroke={colors.chartAxisLine} strokeDasharray="4 8" />
                        <XAxis
                          type="number"
                          tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                          axisLine={false}
                          tickLine={false}
                          tickFormatter={(value: number) => `$${value.toFixed(2)}`}
                        />
                        <YAxis
                          type="category"
                          dataKey="group_label"
                          width={132}
                          tickFormatter={(value: string) => compactChartLabel(value, 18)}
                          tick={{ fill: colors.chartAxisTick, fontSize: 11, fontFamily: 'IBM Plex Mono' }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          itemStyle={{ color: colors.chartTooltipText }}
                          formatter={(value: number, name: string) => {
                            if (name === 'savings_usd') return [formatCost(value), t('cache.labels.saved')]
                            return [value, name]
                          }}
                        />
                        <Bar dataKey="savings_usd" radius={[0, 6, 6, 0]} barSize={22}>
                          {providerCacheByNode.groups.slice(0, 6).map((entry) => (
                            <Cell key={entry.group_value} fill={getNodeColor(entry.group_value)} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>{t('cache.byModel.title')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart
                        data={providerCacheByModel.groups.slice(0, 6)}
                        layout="vertical"
                        margin={{ top: 4, right: 18, left: 4, bottom: 4 }}
                      >
                        <CartesianGrid horizontal={false} stroke={colors.chartAxisLine} strokeDasharray="4 8" />
                        <XAxis
                          type="number"
                          tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                          axisLine={false}
                          tickLine={false}
                          tickFormatter={(value: number) => `$${value.toFixed(2)}`}
                        />
                        <YAxis
                          type="category"
                          dataKey="group_label"
                          width={160}
                          tickFormatter={(value: string) => compactChartLabel(value, 22)}
                          tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          itemStyle={{ color: colors.chartTooltipText }}
                          formatter={(value: number, name: string) => {
                            if (name === 'savings_usd') return [formatCost(value), t('cache.labels.saved')]
                            return [value, name]
                          }}
                        />
                        <Bar dataKey="savings_usd" radius={[0, 6, 6, 0]} barSize={22}>
                          {providerCacheByModel.groups.slice(0, 6).map((entry, index) => (
                            <Cell
                              key={entry.group_value}
                              fill={MODEL_COLORS[index % MODEL_COLORS.length]}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>{t('cache.costMix.title')}</CardTitle>
                </CardHeader>
                <CardContent>
                  {providerCacheByNode.groups.some(row => row.normal_input_cost_usd !== null) ? (<ResponsiveContainer width="100%" height={240}>
                    <BarChart
                      data={providerCacheByNode.groups.slice(0, 6)}
                      layout="vertical"
                      margin={{ top: 4, right: 24, left: 4, bottom: 4 }}
                      barCategoryGap={14}
                    >
                      <CartesianGrid horizontal={false} stroke={colors.chartAxisLine} strokeDasharray="4 8" />
                      <XAxis
                        type="number"
                        tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(value: number) => `$${value.toFixed(2)}`}
                      />
                      <YAxis
                        type="category"
                        dataKey="group_label"
                        width={136}
                        tickFormatter={(value: string) => compactChartLabel(value, 18)}
                        tick={{ fill: colors.chartAxisTick, fontSize: 10, fontFamily: 'IBM Plex Mono' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Legend
                        verticalAlign="top"
                        align="right"
                        iconType="circle"
                        wrapperStyle={{
                          color: colors.chartAxisTick,
                          fontSize: 11,
                          paddingBottom: 8,
                        }}
                        formatter={(value: string) => {
                          if (value === 'normal_input_cost_usd') return t('cache.costMix.normal')
                          if (value === 'cache_read_cost_usd') return t('cache.costMix.read')
                          if (value === 'cache_creation_cost_usd') return t('cache.costMix.write')
                          if (value === 'output_cost_usd') return t('cache.costMix.output')
                          return value
                        }}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        itemStyle={{ color: colors.chartTooltipText }}
                        formatter={(value: number, name: string) => {
                          if (name === 'normal_input_cost_usd') return [formatCost(value), t('cache.costMix.normal')]
                          if (name === 'cache_read_cost_usd') return [formatCost(value), t('cache.costMix.read')]
                          if (name === 'cache_creation_cost_usd') return [formatCost(value), t('cache.costMix.write')]
                          if (name === 'output_cost_usd') return [formatCost(value), t('cache.costMix.output')]
                          return [value, name]
                        }}
                      />
                      <Bar dataKey="normal_input_cost_usd" stackId="cost" fill={CACHE_STACK_COLORS.normal} barSize={18} radius={[6, 0, 0, 6]} />
                      <Bar dataKey="cache_read_cost_usd" stackId="cost" fill={CACHE_STACK_COLORS.read} />
                      <Bar dataKey="cache_creation_cost_usd" stackId="cost" fill={CACHE_STACK_COLORS.write} />
                      <Bar dataKey="output_cost_usd" stackId="cost" fill={CACHE_STACK_COLORS.output} radius={[0, 6, 6, 0]} />
                    </BarChart>
                  </ResponsiveContainer>) : <CacheBreakdownUnavailable />}
                </CardContent>
              </Card>
            </>
          )}
        </CardContent>
      </Card>

      {/* Detailed Breakdown Table */}
      <Card className="animate-fade-up" style={{ animationDelay: '380ms' }}>
        <CardHeader>
          <CardTitle>{t('breakdown.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data.byModel.length === 0 ? (
            <EmptyState icon={DollarSign} title={t('breakdown.emptyTitle')} description={t('breakdown.emptyDescription')} className="py-6" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('breakdown.model')}</TableHead>
                  <TableHead className="text-right">{t('labels.calls')}</TableHead>
                  <TableHead className="text-right">{t('breakdown.inputTokens')}</TableHead>
                  <TableHead className="text-right">{t('breakdown.outputTokens')}</TableHead>
                  <TableHead className="text-right">{t('breakdown.totalCost')}</TableHead>
                  <TableHead className="text-right">{t('breakdown.avgCostCall')}</TableHead>
                  <TableHead className="text-right">{t('breakdown.avgLatency')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.byModel.map((item) => (
                  <TableRow key={item.model}>
                    <TableCell className="font-mono text-[11px] font-medium text-[var(--foreground)]">
                      {item.model}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-[var(--foreground-muted)]">
                      {formatNumber(item.calls)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-[var(--foreground-muted)]">
                      {formatTokens(item.inputTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-[var(--foreground-muted)]">
                      {formatTokens(item.outputTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] font-semibold text-[var(--foreground)]">
                      {formatCost(item.cost)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-[var(--foreground-muted)]">
                      {formatCost(item.avgCostPerCall || 0)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] text-[var(--foreground-muted)]">
                      {formatLatency(item.avgLatency || 0)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

import { formatCacheMoney } from '@/lib/cache-reference-display'
import { useLogCostSummaries } from '@/hooks/use-log-cost-summaries'
import { ReportCostCell } from '@/components/pricing/report-cost-cell'
import { Fragment, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Activity, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, CircleDollarSign, Gauge, KeyRound, Radio, Download, ScrollText, Route, Database, Terminal, Monitor, Code2, Braces } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { NodeIcon } from '@/components/shared/NodeIcon'
import { TierBadge } from '@/components/shared/TierBadge'
import { Card, CardStatic } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Tooltip } from '@/components/ui/tooltip'
import { Skeleton, SkeletonTable } from '@/components/ui/skeleton'
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
import { useLogs, useLogsSummary } from '@/hooks/use-logs'
import { useSSELogs } from '@/hooks/use-sse-logs'
import { useApiKeys } from '@/hooks/use-api-keys'
import { useNamespaces } from '@/hooks/use-namespaces'
import { useNodes } from '@/hooks/use-nodes'
import { formatTimestamp, formatTokens, formatCost, formatLatency } from '@/lib/utils'
import {
  isPromptCacheLog,
  isClientClosedAfterToolCall,
  providerCacheCostBreakdown,
  isProviderCacheLog,
  isSemanticCacheLog,
  sourceFormatLabel,
} from '@/lib/call-log-display'
import { getAuthToken } from '@/contexts/AuthContext'
import type { CallLog, LogsSummaryResponse } from '@/types/api'

const LIMIT = 20
const TABLE_COLUMNS = 13

function SummaryMetric({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Activity }) {
  return (
    <div className="flex min-h-24 items-start justify-between gap-4 border-b border-[var(--border)] p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <div className="min-w-0">
        <div className="text-[11px] font-bold text-[var(--foreground-dim)]">{label}</div>
        <div className="mt-2 truncate font-mono text-[24px] font-bold leading-none text-[var(--foreground)]">
          {value}
        </div>
      </div>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-muted)] text-[var(--accent)]">
        <Icon className="h-4 w-4" />
      </div>
    </div>
  )
}

function LogsSummaryPanel({
  data,
  isLoading,
  isError,
  periodLabel,
}: {
  data?: LogsSummaryResponse
  isLoading: boolean
  isError: boolean
  periodLabel: string
}) {
  const { t } = useTranslation('logs')
  const { t: pricingT } = useTranslation('pricing')

  if (isLoading) {
    return (
      <CardStatic className="animate-fade-up overflow-hidden">
        <div className="border-b border-[var(--border)] p-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mt-2 h-3 w-52" />
        </div>
        <div className="grid sm:grid-cols-3 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="border-b border-[var(--border)] p-4 sm:border-b-0 sm:border-r">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-3 h-7 w-28" />
            </div>
          ))}
        </div>
      </CardStatic>
    )
  }

  if (isError || !data) {
    return (
      <CardStatic className="animate-fade-up p-5 text-[12px] text-[var(--foreground-dim)]">
        {t('summary.unavailable')}
      </CardStatic>
    )
  }

  const total = data.total

  return (
    <CardStatic className="animate-fade-up overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3.5">
        <div>
          <h2 className="text-[14px] font-bold text-[var(--foreground)]">{t('summary.title')}</h2>
          <p className="mt-1 text-[11px] text-[var(--foreground-dim)]">
            {t('summary.description', { period: periodLabel })}
          </p>
        </div>
        <Badge variant="zinc">{periodLabel}</Badge>
      </div>

      <div className="grid sm:grid-cols-3 xl:grid-cols-5">
        <SummaryMetric label={t('summary.requests')} value={total.requests.toLocaleString()} icon={Activity} />
        <SummaryMetric label={t('summary.tokens')} value={formatTokens(total.tokens)} icon={Braces} />
        <SummaryMetric label={pricingT('report.compatibilityCost')} value={formatCost(total.cost_usd)} icon={CircleDollarSign} />
        <SummaryMetric label={t('summary.successRate')} value={`${total.success_rate.toFixed(1)}%`} icon={Gauge} />
        <SummaryMetric label={t('summary.cacheRate')} value={`${total.cache_rate.toFixed(1)}%`} icon={Database} />
      </div>

      <p className="border-t border-[var(--border)] px-4 py-3 text-xs leading-6">{pricingT('report.compatibilityHelp')} <Link to="/pricing/cost-report" className="underline">{pricingT('report.title')}</Link></p>
      <div className="border-t border-[var(--border)]">
        <div className="flex items-center gap-2 px-4 py-3">
          <KeyRound className="h-4 w-4 text-[var(--foreground-dim)]" />
          <h3 className="text-[12px] font-bold text-[var(--foreground)]">{t('summary.byKey')}</h3>
          <span className="font-mono text-[10px] text-[var(--foreground-dim)]">{data.by_key.length}</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('summary.key')}</TableHead>
              <TableHead className="text-right">{t('summary.requests')}</TableHead>
              <TableHead className="text-right">{t('summary.tokens')}</TableHead>
              <TableHead className="text-right">{pricingT('report.compatibilityCost')}</TableHead>
              <TableHead className="text-right">{t('summary.successRate')}</TableHead>
              <TableHead className="text-right">{t('summary.cacheRate')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.by_key.map((row, index) => (
              <TableRow key={row.api_key_id || row.api_key_name || `unassigned-${index}`}>
                <TableCell className="min-w-48">
                  <div className="font-medium text-[var(--foreground)]">
                    {row.api_key_name || t('summary.unassignedKey')}
                  </div>
                  {row.api_key_id && (
                    <div className="mt-0.5 max-w-56 truncate font-mono text-[10px] text-[var(--foreground-dim)]">
                      {row.api_key_id}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono text-[11px]">{row.requests.toLocaleString()}</TableCell>
                <TableCell className="text-right font-mono text-[11px]">{formatTokens(row.tokens)}</TableCell>
                <TableCell className="text-right font-mono text-[11px]">{formatCost(row.cost_usd)}</TableCell>
                <TableCell className="text-right font-mono text-[11px]">{row.success_rate.toFixed(1)}%</TableCell>
                <TableCell className="text-right font-mono text-[11px]">{row.cache_rate.toFixed(1)}%</TableCell>
              </TableRow>
            ))}
            {data.by_key.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-[12px] text-[var(--foreground-dim)]">
                  {t('summary.noData')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </CardStatic>
  )
}

function formatBytes(value?: number | null) {
  if (value === null || value === undefined) return null
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

function LogRouteBadge({ log }: { log: CallLog }) {
  const { t } = useTranslation('logs')
  if (isPromptCacheLog(log)) {
    return <Badge variant="emerald">{t('cache.hit')}</Badge>
  }
  if (isSemanticCacheLog(log)) {
    return <Badge variant="emerald">{t('cache.semanticHit')}</Badge>
  }
  return <TierBadge tier={log.tier} />
}

function ProviderCacheBadge({ log }: { log: CallLog }) {
  const { t, i18n } = useTranslation('logs')
  if (!isProviderCacheLog(log)) return null
  const cacheCost = providerCacheCostBreakdown(log)

  return (
    <Tooltip
      content={
        cacheCost.hasSavingsEstimate
          ? t('cache.tooltip', {
              cached: formatTokens(cacheCost.cachedInputTokens),
              total: formatTokens(log.input_tokens || 0),
              saved: formatCacheMoney(cacheCost.savedCostUsdExact, i18n.resolvedLanguage ?? i18n.language),
            })
          : t('cache.tooltipUnpriced', {
              defaultValue: '{{cached}} / {{total}} tokens cached; no comparable baseline was retained',
              cached: formatTokens(cacheCost.cachedInputTokens),
              total: formatTokens(log.input_tokens || 0),
            })
      }
    >
      <Badge variant="emerald" className="gap-1">
        <Database className="h-3 w-3" />
        {t('cache.providerBadge')}
      </Badge>
    </Tooltip>
  )
}

function SourceBadge({ sourceFormat }: { sourceFormat: string }) {
  const { t } = useTranslation('logs')
  return (
    <Badge variant="blue" className="max-w-[150px] truncate whitespace-nowrap">
      {sourceFormatLabel(sourceFormat, t)}
    </Badge>
  )
}

function clientSourceIcon(source?: string | null) {
  if (!source) return Monitor
  if (['curl', 'postman', 'insomnia', 'python_http', 'node_http', 'http_client'].includes(source)) {
    return Terminal
  }
  if (['claude_code', 'codex', 'cherry_studio', 'hermes', 'openclaw', 'cursor', 'cline'].includes(source)) {
    return Code2
  }
  return Monitor
}

function ClientSourceBadge({ source }: { source?: string | null }) {
  const { t } = useTranslation('logs')
  const Icon = clientSourceIcon(source)
  const label = source
    ? t(`clientSource.${source}`, { defaultValue: source.replaceAll('_', ' ') })
    : t('clientSource.unknown')
  return (
    <Badge variant={source ? 'zinc' : 'default'} className="max-w-[150px] gap-1 truncate whitespace-nowrap">
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </Badge>
  )
}

function DeliveryModeBadge({ stream }: { stream?: boolean }) {
  const { t } = useTranslation('logs')
  return (
    <Badge variant={stream ? 'emerald' : 'zinc'} className="max-w-[120px] truncate whitespace-nowrap">
      {stream ? t('table.streamMode.stream') : t('table.streamMode.sync')}
    </Badge>
  )
}

function UpstreamProtocolBadge({
  log,
  protocol,
}: {
  log: CallLog
  protocol?: string | null
}) {
  const { t } = useTranslation('logs')
  if (isPromptCacheLog(log) || isSemanticCacheLog(log)) {
    return (
      <Badge variant="zinc" className="max-w-[150px] truncate whitespace-nowrap">
        {t('cache.noUpstream')}
      </Badge>
    )
  }
  if (!protocol) {
    return (
      <span className="font-mono text-[11px] text-[var(--foreground-dim)]">
        {t('common.na')}
      </span>
    )
  }
  return (
    <Badge variant="purple" className="max-w-[150px] truncate whitespace-nowrap">
      {sourceFormatLabel(protocol, t)}
    </Badge>
  )
}

function CredentialBadge({ log, isCache }: { log: CallLog; isCache: boolean }) {
  const { t } = useTranslation('logs')
  if (isCache) {
    return <Badge variant="zinc">{t('cache.noUpstream')}</Badge>
  }

  const credentialId = log.credential_id || 'default'
  const isDefault = credentialId === 'default'

  return (
    <span className="inline-flex min-w-0 items-center gap-2 align-middle">
      <Badge
        variant={isDefault ? 'amber' : 'blue'}
        className="max-w-[190px] truncate whitespace-nowrap font-mono normal-case tracking-normal"
      >
        {isDefault ? t('detail.defaultCredential') : credentialId}
      </Badge>
      {(log.credential_strategy || (log.credential_retry_count ?? 0) > 0) && (
        <span className="min-w-0 truncate font-mono text-[11px] text-[var(--foreground-dim)]">
          {[log.credential_strategy, t('detail.credentialRetry', { count: log.credential_retry_count ?? 0 })]
            .filter(Boolean)
            .join(' / ')}
        </span>
      )}
    </span>
  )
}

function UpstreamCell({ log }: { log: CallLog }) {
  const { t } = useTranslation('logs')
  if (isPromptCacheLog(log)) {
    return (
      <div className="min-w-0">
        <span className="font-medium text-[var(--foreground-dim)]">{t('cache.noUpstream')}</span>
        <div className="mt-1 font-mono text-[10px] text-[var(--foreground-dim)]">{t('cache.promptCache')}</div>
      </div>
    )
  }
  if (isSemanticCacheLog(log)) {
    return (
      <div className="min-w-0">
        <span className="font-medium text-[var(--foreground-dim)]">{t('cache.noUpstream')}</span>
        <div className="mt-1 font-mono text-[10px] text-[var(--foreground-dim)]">{t('cache.semanticCache')}</div>
      </div>
    )
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--background-secondary)]">
        <NodeIcon
          nodeId={log.node_id}
          providerName={log.node_id}
          modelIds={[log.model].filter(Boolean)}
          className="h-4 w-4"
        />
      </span>
      <span className="truncate font-medium text-[var(--foreground)]">{log.node_id}</span>
    </div>
  )
}

function LogDetailRow({
  log,
  upstreamProtocol,
}: {
  log: CallLog
  upstreamProtocol?: string | null
}) {
  const { t, i18n } = useTranslation('logs')
  const { t: pricingT } = useTranslation('pricing')
  const mediaByteSize = formatBytes(log.media_byte_size)
  const isSemanticCache = isSemanticCacheLog(log)
  const isCache = isPromptCacheLog(log) || isSemanticCache
  const isProviderCache = isProviderCacheLog(log)
  const isToolCallHandoff = isClientClosedAfterToolCall(log)
  const cacheCost = providerCacheCostBreakdown(log)
  const cachedInputPercent = `${(cacheCost.cachedInputRatio * 100).toFixed(1)}%`
  const hasFallbackEvidence = log.is_fallback || Boolean(log.fallback_reason)
  const hasStructuredOutputEvidence =
    log.structured_output_requested ||
    Boolean(log.structured_output_type) ||
    Boolean(log.structured_output_strategy) ||
    log.structured_output_supported === false
  const hasReasoningEvidence =
    log.reasoning_requested ||
    Boolean(log.reasoning_effort) ||
    Boolean(log.reasoning_strategy) ||
    (log.reasoning_budget_tokens !== null && log.reasoning_budget_tokens !== undefined) ||
    log.reasoning_supported === false
  return (
    <TableRow>
      <TableCell colSpan={TABLE_COLUMNS} className="bg-[var(--inset-bg)] px-6 py-4">
        <div className="grid gap-4 text-xs md:grid-cols-2 xl:grid-cols-3">
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.requestId')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">{log.request_id}</span>
          </div>
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.score')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">{log.score?.toFixed(3) ?? t('common.na')}</span>
          </div>
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.sourceFormat')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">
              {sourceFormatLabel(log.source_format, t)}
            </span>
          </div>
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.clientSource')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">
              {log.client_source
                ? t(`clientSource.${log.client_source}`, {
                    defaultValue: log.client_source.replaceAll('_', ' '),
                  })
                : t('clientSource.unknown')}
            </span>
          </div>
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.routeResult')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">
              {isSemanticCache
                ? t('cache.semanticHit')
                : isCache
                  ? t('cache.hit')
                  : t(`tiers.${log.tier}`, { defaultValue: log.tier })}
            </span>
          </div>
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.upstream')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">
              {isCache ? t('cache.noUpstream') : log.node_id}
            </span>
          </div>
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.credential')}: </span>
            <CredentialBadge log={log} isCache={isCache} />
          </div>
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.upstreamProtocol')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">
              {isCache
                ? t('cache.noUpstream')
                : upstreamProtocol
                  ? sourceFormatLabel(upstreamProtocol, t)
                  : t('common.na')}
            </span>
          </div>
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.deliveryMode')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">
              {log.stream ? t('table.streamMode.stream') : t('table.streamMode.sync')}
            </span>
          </div>
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.totalTime')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">
              {formatLatency(log.latency_ms)}
            </span>
          </div>
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.apiKey')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">{log.api_key_name ?? t('common.na')}</span>
          </div>
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.namespace')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">{log.namespace_id ?? 'default'}</span>
          </div>
          {log.session_key && (
            <div>
              <span className="text-[var(--foreground-dim)]">{t('detail.sessionKey')}: </span>
              <span className="font-mono text-[var(--foreground-muted)]">{log.session_key}</span>
            </div>
          )}
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.fallback')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">{log.is_fallback ? t('common.yes') : t('common.no')}</span>
          </div>
          {hasFallbackEvidence && (
            <div>
              <span className="text-[var(--foreground-dim)]">{t('detail.fallbackReason')}: </span>
              <span className="font-mono text-[var(--foreground-muted)]">{log.fallback_reason ?? t('common.na')}</span>
            </div>
          )}
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.structuredOutput')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">{log.structured_output_requested ? t('common.yes') : t('common.no')}</span>
          </div>
          {hasStructuredOutputEvidence && (
            <>
              <div>
                <span className="text-[var(--foreground-dim)]">{t('detail.structuredOutputType')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">{log.structured_output_type ?? t('common.na')}</span>
              </div>
              <div>
                <span className="text-[var(--foreground-dim)]">{t('detail.structuredOutputStrategy')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">
                  {log.structured_output_strategy ?? t('common.na')}
                  {log.structured_output_supported === false ? ` / ${t('detail.unsupported')}` : ''}
                </span>
              </div>
            </>
          )}
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.reasoning')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">
              {log.reasoning_requested ? t('common.yes') : t('common.no')}
            </span>
          </div>
          {hasReasoningEvidence && (
            <>
              <div>
                <span className="text-[var(--foreground-dim)]">{t('detail.reasoningEffort')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">
                  {log.reasoning_effort ?? t('common.na')}
                </span>
              </div>
              <div>
                <span className="text-[var(--foreground-dim)]">{t('detail.reasoningStrategy')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">
                  {log.reasoning_strategy ?? t('common.na')}
                  {log.reasoning_supported === false ? ` / ${t('detail.unsupported')}` : ''}
                </span>
              </div>
              {log.reasoning_budget_tokens !== null && log.reasoning_budget_tokens !== undefined && (
                <div>
                  <span className="text-[var(--foreground-dim)]">{t('detail.reasoningBudget')}: </span>
                  <span className="font-mono text-[var(--foreground-muted)]">
                    {log.reasoning_budget_tokens.toLocaleString()}
                  </span>
                </div>
              )}
            </>
          )}
          {log.reasoning_reason && (
            <div>
              <span className="text-[var(--foreground-dim)]">{t('detail.reasoningReason')}: </span>
              <span className="font-mono text-[var(--foreground-muted)]">{log.reasoning_reason}</span>
            </div>
          )}
          {log.media_type && (
            <>
              <div>
                <span className="text-[var(--foreground-dim)]">{t('detail.mediaOperation')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">
                  {log.media_type}/{log.media_operation ?? t('common.na')}
                </span>
              </div>
              <div>
                <span className="text-[var(--foreground-dim)]">{t('detail.mediaBytes')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">{mediaByteSize ?? t('common.na')}</span>
              </div>
              <div>
                <span className="text-[var(--foreground-dim)]">{t('detail.providerResponseType')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">{log.media_provider_response_type ?? t('common.na')}</span>
              </div>
              <div>
                <span className="text-[var(--foreground-dim)]">{t('detail.mediaFiles')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">
                  {t('detail.mediaFilesValue', {
                    count: log.media_file_count ?? 0,
                    multipart: log.media_multipart ? t('common.yes') : t('common.no'),
                  })}
                </span>
              </div>
              <div>
                <span className="text-[var(--foreground-dim)]">{t('detail.requestedFormat')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">{log.media_requested_format ?? t('common.na')}</span>
              </div>
              <div>
                <span className="text-[var(--foreground-dim)]">{t('detail.responseFormat')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">{log.media_response_format ?? t('common.na')}</span>
              </div>
            </>
          )}
          {(isCache || log.cache_creation_input_tokens || log.cache_read_input_tokens) && (
            <>
              <div>
                <span className="text-[var(--foreground-dim)]">{t('cache.kind')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">
                  {isSemanticCache
                    ? t('cache.semanticCache')
                    : isPromptCacheLog(log)
                      ? t('cache.promptCache')
                      : t('cache.providerCache')}
                </span>
              </div>
              {isSemanticCache && (
                <div>
                  <span className="text-[var(--foreground-dim)]">{t('cache.semanticScore')}: </span>
                  <span className="font-mono text-[var(--foreground-muted)]">
                    {log.semantic_cache_score !== null && log.semantic_cache_score !== undefined
                      ? log.semantic_cache_score.toFixed(3)
                      : t('common.na')}
                  </span>
                </div>
              )}
              <div>
                <span className="text-[var(--foreground-dim)]">{t('cache.readTokens')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">{log.cache_read_input_tokens ?? 0}</span>
              </div>
              <div>
                <span className="text-[var(--foreground-dim)]">{t('cache.creationTokens')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">{log.cache_creation_input_tokens ?? 0}</span>
              </div>
              {isProviderCache && (
                <>
                  <div>
                    <span className="text-[var(--foreground-dim)]">
                      {t('cache.cachedTokens', { defaultValue: 'cached tokens' })}:{' '}
                    </span>
                    <span className="font-mono text-[var(--foreground-muted)]">
                      {t('cache.cachedTokensValue', {
                        defaultValue: '{{cached}} / {{total}} ({{percent}})',
                        cached: formatTokens(cacheCost.cachedInputTokens),
                        total: formatTokens(log.input_tokens || 0),
                        percent: cachedInputPercent,
                      })}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--foreground-dim)]">
                      {t('cache.actualCost', { defaultValue: 'recorded comparison cost' })}:{' '}
                    </span>
                    <span className="font-mono text-[var(--foreground-muted)]">
                      {formatCacheMoney(cacheCost.actualCostUsd, i18n.resolvedLanguage ?? i18n.language)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--foreground-dim)]">{t('cache.withoutCacheCost')}: </span>
                    <span className="font-mono text-[var(--foreground-muted)]">
                      {cacheCost.hasNoCacheEstimate
                        ? formatCacheMoney(cacheCost.withoutCacheCostUsd, i18n.resolvedLanguage ?? i18n.language)
                        : t('common.na')}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--foreground-dim)]">{t('cache.savedCost')}: </span>
                    <span
                      className={
                        cacheCost.savedCostUsd !== null && cacheCost.savedCostUsd >= 0
                          ? 'font-mono text-emerald-700 dark:text-emerald-300'
                          : 'font-mono text-amber-700 dark:text-amber-300'
                      }
                    >
                      {cacheCost.hasSavingsEstimate
                        ? formatCacheMoney(cacheCost.savedCostUsdExact, i18n.resolvedLanguage ?? i18n.language)
                        : t('cache.savingsUnpriced', {
                            defaultValue: 'no comparable baseline recorded',
                          })}
                    </span>
                  </div>
                </>
              )}
              <div>
                <span className="text-[var(--foreground-dim)]">{t('cache.routingEffect')}: </span>
                <span className="font-mono text-[var(--foreground-muted)]">
                  {isCache
                    ? isSemanticCache
                      ? t('cache.semanticBypass')
                      : t('cache.localBypass')
                    : (log.cache_read_input_tokens || log.cache_creation_input_tokens)
                      ? t('cache.providerEvidence')
                      : t('cache.noEvidence')}
                </span>
              </div>
            </>
          )}
          <div>
            <span className="text-[var(--foreground-dim)]">{t('detail.tokens')}: </span>
            <span className="font-mono text-[var(--foreground-muted)]">
              {t('detail.tokensInOut', { input: log.input_tokens, output: log.output_tokens })}
            </span>
          </div>
          {log.error && (
            <div className="col-span-3">
              <span className="text-[var(--foreground-dim)]">
                {isToolCallHandoff ? t('detail.outcome') : t('detail.error')}: {' '}
              </span>
              <span
                className={
                  isToolCallHandoff
                    ? 'font-mono text-[var(--foreground-muted)]'
                    : 'font-mono text-red-600 dark:text-red-400'
                }
              >
                {log.error}
              </span>
            </div>
          )}
          <div className="flex flex-wrap gap-2 md:col-span-2 xl:col-span-3">
            <Link to={`/logs/${log.id}/cost`} className={buttonVariants({ variant: 'outline', size: 'sm', className: 'mt-1' })}><CircleDollarSign className="h-3.5 w-3.5" />{pricingT('cost.view')}</Link>
            <Link
              to={`/route-decisions/${encodeURIComponent(log.request_id)}`}
              className={buttonVariants({ variant: 'outline', size: 'sm', className: 'mt-1' })}
            >
              <Route className="h-3.5 w-3.5" />
              {t('detail.explainRoute')}
            </Link>
          </div>
        </div>
      </TableCell>
    </TableRow>
  )
}

export function LogsPage() {
  const { t } = useTranslation('logs')
  const { t: pricingT } = useTranslation('pricing')
  const [page, setPage] = useState(1)
  const [tierFilter, setTierFilter] = useState('')
  const [nodeFilter, setNodeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [apiKeyFilter, setApiKeyFilter] = useState('')
  const [namespaceFilter, setNamespaceFilter] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [exportFormat, setExportFormat] = useState('csv')
  const [timeRange, setTimeRange] = useState('today')

  const { data: apiKeysData } = useApiKeys()
  const { data: namespacesData } = useNamespaces()
  const { data: nodesData } = useNodes()
  const protocolByNodeId = useMemo(
    () => new Map((nodesData?.nodes || []).map((node) => [node.id, node.protocol])),
    [nodesData?.nodes],
  )
  const tierOptions = [
    { value: '', label: t('filters.allTiers') },
    { value: 'simple', label: t('tiers.simple') },
    { value: 'standard', label: t('tiers.standard') },
    { value: 'complex', label: t('tiers.complex') },
    { value: 'reasoning', label: t('tiers.reasoning') },
  ]
  const statusOptions = [
    { value: '', label: t('filters.allStatus') },
    { value: '200', label: t('filters.status200') },
    { value: '500', label: t('filters.status500') },
    { value: '429', label: t('filters.status429') },
  ]
  const exportFormatOptions = [
    { value: 'csv', label: t('export.csv') },
    { value: 'json', label: t('export.json') },
  ]
  const timeRangeOptions = [
    { value: '15m', label: t('timeRange.15m') },
    { value: '30m', label: t('timeRange.30m') },
    { value: '1h', label: t('timeRange.1h') },
    { value: '6h', label: t('timeRange.6h') },
    { value: 'today', label: t('timeRange.today') },
    { value: '7d', label: t('timeRange.7d') },
    { value: '30d', label: t('timeRange.30d') },
    { value: '90d', label: t('timeRange.90d') },
  ]
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

  const logFilters = {
    tier: tierFilter || undefined,
    node: nodeFilter || undefined,
    status: statusFilter || undefined,
    api_key_id: apiKeyFilter || undefined,
    namespace: namespaceFilter || undefined,
    period: timeRange,
  }

  const { data: logsData, isLoading, isError, error, refetch } = useLogs(page, LIMIT, logFilters)
  const {
    data: summaryData,
    isLoading: isSummaryLoading,
    isError: isSummaryError,
    refetch: refetchSummary,
  } = useLogsSummary(logFilters)

  const costs = useLogCostSummaries(logsData?.data.map(log => log.id) ?? [])
  const costById = new Map(costs.data?.rows.map(row => [row.log_id, row]) ?? [])
  const { newCount, clearNewCount } = useSSELogs(100)

  const handleRefresh = () => {
    clearNewCount()
    refetch()
    refetchSummary()
    void costs.refetch()
  }

  const handleTimeRangeChange = (value: string) => {
    setTimeRange(value)
    setPage(1)
  }

  const handleExport = () => {
    const token = getAuthToken()
    const params = new URLSearchParams({ format: exportFormat, period: timeRange })
    if (apiKeyFilter) params.set('api_key_id', apiKeyFilter)
    if (namespaceFilter) params.set('namespace', namespaceFilter)
    const url = `/api/dashboard/logs/export?${params.toString()}`
    // Use a hidden link with auth header via fetch + blob download
    fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => res.blob())
      .then((blob) => {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `logs-${timeRange}.${exportFormat}`
        a.click()
        URL.revokeObjectURL(a.href)
      })
      .catch(() => {})
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('logs.title')}
        description={t('logs.description')}
        icon={ScrollText}
      >
        <div className="flex items-center gap-2">
          <Select
            options={timeRangeOptions}
            value={timeRange}
            onChange={handleTimeRangeChange}
            className="h-8 w-28 text-[11px]"
          />
          <Select
            options={exportFormatOptions}
            value={exportFormat}
            onChange={(v) => setExportFormat(v)}
            className="w-20 h-8 text-[11px]"
          />
          <Link to="/pricing/cost-report" className={buttonVariants({ variant: 'outline', size: 'sm' })}>{pricingT('report.title')}</Link>
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="h-3.5 w-3.5" />
            {t('export.button')}
          </Button>
        </div>
      </PageHeader>

      {/* SSE New Logs Banner */}
      {newCount > 0 && (
        <button
          onClick={handleRefresh}
          className="flex w-full items-center justify-center gap-2.5 rounded-2xl border border-[var(--sse-border)] bg-[var(--sse-bg)] px-4 py-2.5 text-[13px] font-medium text-[var(--sse-text)] transition-all duration-300 hover:opacity-80 cursor-pointer"
          style={{ boxShadow: '0 0 24px var(--accent-glow)' }}
        >
          <Radio className="h-3.5 w-3.5 animate-pulse" />
          {t('sse.newLogsReceived', { count: newCount })}
        </button>
      )}

      <LogsSummaryPanel
        data={summaryData}
        isLoading={isSummaryLoading}
        isError={isSummaryError}
        periodLabel={timeRangeOptions.find((option) => option.value === timeRange)?.label || timeRange}
      />

      {/* Filters */}
      <CardStatic className="animate-fade-up p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            options={tierOptions}
            value={tierFilter}
            onChange={(v) => {
              setTierFilter(v)
              setPage(1)
            }}
            className="w-36"
          />
          <Input
            placeholder={t('filters.nodePlaceholder')}
            value={nodeFilter}
            onChange={(e) => {
              setNodeFilter(e.target.value)
              setPage(1)
            }}
            className="w-40"
          />
          <Select
            options={statusOptions}
            value={statusFilter}
            onChange={(v) => {
              setStatusFilter(v)
              setPage(1)
            }}
            className="w-36"
          />
          <Select
            options={apiKeyOptions}
            value={apiKeyFilter}
            onChange={(v) => {
              setApiKeyFilter(v)
              setPage(1)
            }}
            className="w-36"
          />
          <Select
            options={namespaceOptions}
            value={namespaceFilter}
            onChange={(v) => {
              setNamespaceFilter(v)
              setPage(1)
            }}
            className="w-40"
          />
          <div className="ml-auto font-mono text-[11px] text-[var(--foreground-dim)]">
            {logsData?.pagination
              ? t('pagination.totalLogs', { count: logsData.pagination.total })
              : '...'}
          </div>
        </div>
      </CardStatic>

      {/* Table */}
      <CardStatic className="animate-fade-up" style={{ animationDelay: '80ms' }}>
        {isError ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : isLoading ? (
          <SkeletonTable rows={10} cols={TABLE_COLUMNS} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>{t('table.time')}</TableHead>
                  <TableHead>{t('table.source')}</TableHead>
                  <TableHead>{t('table.clientSource')}</TableHead>
                  <TableHead>{t('table.routeResult')}</TableHead>
                  <TableHead>{t('table.upstream')}</TableHead>
                  <TableHead>{t('table.upstreamProtocol')}</TableHead>
                  <TableHead>{t('table.model')}</TableHead>
                  <TableHead>{t('table.deliveryMode')}</TableHead>
                  <TableHead className="text-right">{t('table.tokens')}</TableHead>
                  <TableHead className="text-right">{t('table.cost')}</TableHead>
                  <TableHead className="text-right">{t('table.latency')}</TableHead>
                  <TableHead className="text-right">{t('table.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logsData?.data.map((log) => (
                  <Fragment key={log.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() =>
                        setExpandedId(expandedId === log.id ? null : log.id)
                      }
                    >
                      <TableCell>
                        {expandedId === log.id ? (
                          <ChevronUp className="h-3.5 w-3.5 text-[var(--foreground-dim)]" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 text-[var(--foreground-dim)]" />
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-[var(--foreground-muted)]">
                        {formatTimestamp(log.timestamp)}
                      </TableCell>
                      <TableCell>
                        <SourceBadge sourceFormat={log.source_format} />
                      </TableCell>
                      <TableCell>
                        <ClientSourceBadge source={log.client_source} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <LogRouteBadge log={log} />
                          <ProviderCacheBadge log={log} />
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[160px]">
                        <UpstreamCell log={log} />
                      </TableCell>
                      <TableCell>
                        <UpstreamProtocolBadge
                          log={log}
                          protocol={protocolByNodeId.get(log.node_id)}
                        />
                      </TableCell>
                      <TableCell className="max-w-[180px] truncate font-mono text-[11px] text-[var(--foreground-dim)]">
                        <Tooltip content={log.model}>
                          <span className="block truncate">{log.model}</span>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <DeliveryModeBadge stream={log.stream} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] text-[var(--foreground-muted)]">
                        {formatTokens(log.input_tokens + log.output_tokens)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] text-[var(--foreground-muted)]">
                        <ReportCostCell row={costById.get(log.id)} failed={costs.isError} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] text-[var(--foreground-muted)]">
                        {formatLatency(log.latency_ms)}
                      </TableCell>
                      <TableCell className="text-right">
                        {isClientClosedAfterToolCall(log) ? (
                          <Tooltip content="client_closed_after_tool_call">
                            <Badge variant="zinc" className="whitespace-nowrap">
                              {t('status.toolCallHandedOff')}
                            </Badge>
                          </Tooltip>
                        ) : (
                          <span
                            className={`font-mono text-[11px] font-semibold ${
                              log.status_code === 200
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-red-600 dark:text-red-400'
                            }`}
                          >
                            {log.status_code}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                    {expandedId === log.id && (
                      <LogDetailRow
                        key={`detail-${log.id}`}
                        log={log}
                        upstreamProtocol={protocolByNodeId.get(log.node_id)}
                      />
                    )}
                  </Fragment>
                ))}
                {(!logsData?.data || logsData.data.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={TABLE_COLUMNS} className="p-0">
                      <EmptyState
                        icon={ScrollText}
                        title={t('empty.title')}
                        description={t('empty.description')}
                      />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>

            {/* Pagination */}
            {logsData?.pagination && logsData.pagination.totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3">
                <div className="font-mono text-[11px] text-[var(--foreground-dim)]">
                  {t('pagination.pageOf', {
                    page: logsData.pagination.page,
                    totalPages: logsData.pagination.totalPages,
                  })}
                </div>
                <div className="flex gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    {t('pagination.prev')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page >= logsData.pagination.totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    {t('pagination.next')}
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardStatic>
    </div>
  )
}

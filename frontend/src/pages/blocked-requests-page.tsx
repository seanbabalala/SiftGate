import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Gauge, KeyRound, ShieldAlert, ShieldCheck, Wallet } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { MetricCard } from '@/components/shared/MetricCard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardStatic, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Select } from '@/components/ui/select'
import { SkeletonTable } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useApiKeys } from '@/hooks/use-api-keys'
import {
  GOVERNANCE_DENIAL_REASONS,
  type GovernanceDenialPeriod,
  type GovernanceDenialReason,
  useGovernanceDenialSummary,
  useGovernanceDenials,
} from '@/hooks/use-governance-denials'
import { formatDate, formatNumber } from '@/lib/utils'

const LIMIT = 25
const PERIODS: GovernanceDenialPeriod[] = ['1h', '24h', '7d', '30d']

// Where an administrator changes the policy behind each reason.
const REASON_TARGET: Record<GovernanceDenialReason, string> = {
  budget_exceeded: '/budget',
  rate_limited: '/api-keys',
  endpoint_not_allowed: '/api-keys',
  modality_not_allowed: '/api-keys',
  routing_mode_not_allowed: '/api-keys',
  model_not_allowed: '/api-keys',
}

function reasonTone(reason: GovernanceDenialReason) {
  if (reason === 'budget_exceeded') return 'amber' as const
  if (reason === 'rate_limited') return 'blue' as const
  return 'red' as const
}

export function BlockedRequestsPage() {
  const { t } = useTranslation('logs')
  const [period, setPeriod] = useState<GovernanceDenialPeriod>('24h')
  const [reason, setReason] = useState('')
  const [apiKeyId, setApiKeyId] = useState('')
  const [page, setPage] = useState(1)

  const summary = useGovernanceDenialSummary(period)
  const denials = useGovernanceDenials({ period, reason, apiKeyId, page, limit: LIMIT })
  const apiKeys = useApiKeys()

  const reasonOptions = useMemo(
    () => [
      { value: '', label: t('blocked.filters.allReasons') },
      ...GOVERNANCE_DENIAL_REASONS.map((value) => ({ value, label: t(`blocked.reason.${value}`) })),
    ],
    [t],
  )
  const apiKeyOptions = useMemo(
    () => [
      { value: '', label: t('filters.allApiKeys') },
      ...(apiKeys.data?.items || []).map((key) => ({ value: key.id, label: key.name })),
    ],
    [apiKeys.data?.items, t],
  )
  const periodOptions = PERIODS.map((value) => ({ value, label: t(`blocked.period.${value}`) }))

  const byReason = new Map((summary.data?.by_reason || []).map((row) => [row.reason, row.requests]))
  const total = summary.data?.total || 0
  const budget = byReason.get('budget_exceeded') || 0
  const rateLimited = byReason.get('rate_limited') || 0
  const keyPolicy = Math.max(0, total - budget - rateLimited)
  const topKey = summary.data?.by_key[0]
  const pagination = denials.data?.pagination
  // Changing any filter starts again at the first page.
  const onFilter = (setter: (value: string) => void) => (value: string) => {
    setter(value)
    setPage(1)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('blocked.title')}
        description={t('blocked.description')}
        icon={ShieldAlert}
        badge={
          <Badge variant="gold" className="gap-1">
            <ShieldCheck className="h-3 w-3" />
            {t('blocked.metadataOnly')}
          </Badge>
        }
      />

      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard
          label={t('blocked.metrics.total')}
          value={formatNumber(total)}
          subtitle={
            topKey
              ? t('blocked.metrics.topKey', { key: topKey.api_key_name || topKey.api_key_id || t('blocked.values.unknownKey') })
              : t(`blocked.period.${period}`)
          }
          icon={ShieldAlert}
        />
        <MetricCard
          label={t('blocked.metrics.budget')}
          value={formatNumber(budget)}
          subtitle={t('blocked.metrics.budgetHint')}
          icon={Wallet}
        />
        <MetricCard
          label={t('blocked.metrics.keyPolicy')}
          value={formatNumber(keyPolicy)}
          subtitle={t('blocked.metrics.keyPolicyHint')}
          icon={KeyRound}
        />
        <MetricCard
          label={t('blocked.metrics.rateLimited')}
          value={formatNumber(rateLimited)}
          subtitle={t('blocked.metrics.rateLimitedHint')}
          icon={Gauge}
        />
      </div>

      <CardStatic>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select value={period} onChange={onFilter((value) => setPeriod(value as GovernanceDenialPeriod))} options={periodOptions} className="w-40" />
            <Select value={reason} onChange={onFilter(setReason)} options={reasonOptions} className="w-52" />
            <Select value={apiKeyId} onChange={onFilter(setApiKeyId)} options={apiKeyOptions} className="w-44" />
            <p className="ml-auto max-w-md text-[12px] text-[var(--foreground-dim)]">{t('blocked.bucketNote')}</p>
          </div>

          {denials.isError ? (
            <ErrorState error={denials.error as Error} onRetry={() => denials.refetch()} />
          ) : denials.isLoading ? (
            <SkeletonTable rows={6} cols={6} />
          ) : (denials.data?.data.length || 0) === 0 ? (
            <EmptyState icon={ShieldCheck} title={t('blocked.empty.title')} description={t('blocked.empty.description')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('blocked.table.time')}</TableHead>
                  <TableHead>{t('blocked.table.reason')}</TableHead>
                  <TableHead>{t('blocked.table.key')}</TableHead>
                  <TableHead>{t('blocked.table.request')}</TableHead>
                  <TableHead className="text-right">{t('blocked.table.count')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {denials.data?.data.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap font-mono text-[12px] text-[var(--foreground-dim)]">
                      {formatDate(row.first_at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant={reasonTone(row.reason)} className="whitespace-nowrap">{t(`blocked.reason.${row.reason}`)}</Badge>
                        <span className="font-mono text-[11px] text-[var(--foreground-dim)]">{row.status_code}</span>
                      </div>
                      {row.budget_scope && (
                        <div className="mt-1 text-[11px] text-[var(--foreground-dim)]">
                          {t(`blocked.scope.${row.budget_scope}`, { defaultValue: row.budget_scope })}
                        </div>
                      )}
                      <Link to={REASON_TARGET[row.reason]} className="mt-1 block whitespace-nowrap text-[11px] font-semibold text-[var(--accent)] hover:underline">
                        {t(row.reason === 'budget_exceeded' ? 'blocked.action.budget' : 'blocked.action.key')}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="text-[12px] font-semibold text-[var(--foreground)]">
                        {row.api_key_name || row.api_key_id || t('blocked.values.unknownKey')}
                      </div>
                      {(row.namespace_id || row.team_id) && (
                        <div className="mt-0.5 font-mono text-[11px] text-[var(--foreground-dim)]">
                          {[row.namespace_id, row.team_id].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {row.requested_model && (
                        <div className="font-mono text-[12px] text-[var(--foreground)]">{row.requested_model}</div>
                      )}
                      {(row.source_format || row.client_source) && (
                        <div className="mt-0.5 font-mono text-[11px] text-[var(--foreground-dim)]">
                          {[row.source_format, row.client_source].filter(Boolean).join(' · ')}
                        </div>
                      )}
                      {!row.requested_model && !row.source_format && !row.client_source && (
                        <div className="text-[12px] text-[var(--foreground-dim)]">{t('blocked.values.notRecorded')}</div>
                      )}
                      {row.first_request_id && (
                        <div className="mt-0.5 max-w-[220px] truncate font-mono text-[11px] text-[var(--foreground-dim)]" title={row.first_request_id}>
                          {row.first_request_id}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[12px] text-[var(--foreground)]">
                      {formatNumber(row.request_count)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-end gap-2">
              <span className="text-[12px] text-[var(--foreground-dim)]">
                {t('blocked.pagination', { page: pagination.page, total: pagination.totalPages })}
              </span>
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('blocked.previousPage')}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)} aria-label={t('blocked.nextPage')}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </CardContent>
      </CardStatic>
    </div>
  )
}

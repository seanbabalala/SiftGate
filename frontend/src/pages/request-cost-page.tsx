import { lazy, Suspense, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ReceiptText, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, buttonVariants } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { SkeletonCard } from '@/components/ui/skeleton'
import { hasWorkspaceRole, useWorkspaces } from '@/hooks/use-workspaces'
import { scopedDashboardClient } from '@/lib/pricing-client'
import { PricingNavigationGuard } from '@/components/pricing/pricing-navigation-guard'
import { pricingErrorKey } from '@/components/pricing/price-simulator'
import { CostFacts, CostValue } from '@/components/pricing/cost-metadata'
import { RequestCostEvidence } from '@/components/pricing/request-cost-evidence'
import { LocalCacheAccounting } from '@/components/pricing/local-cache-accounting'
import type { PricingLogCost } from '@/types/pricing'

const RequestCostReplay = lazy(() => import('@/components/pricing/request-cost-replay').then(module => ({ default: module.RequestCostReplay })))

export function RequestCostPage() {
  const { t } = useTranslation('pricing'), { id = '' } = useParams()
  const { data, error, isLoading } = useWorkspaces()
  if (isLoading) return <SkeletonCard />
  if (error || !data) return <p role="alert">{t('error.workspace')}</p>
  return <PricingNavigationGuard key={`${data.active_workspace.id}/${id}`}><RequestCost workspace={data.active_workspace.id} id={id} canManage={hasWorkspaceRole(data.access, 'admin')} canInspect={hasWorkspaceRole(data.access, 'operator')} /></PricingNavigationGuard>
}
function RequestCost({ workspace, id, canManage, canInspect }: { workspace: string; id: string; canManage: boolean; canInspect: boolean }) {
  const { t, i18n } = useTranslation('pricing'), client = useQueryClient()
  const request = useMemo(() => scopedDashboardClient(workspace), [workspace])
  const [tab, setTab] = useState<'evidence' | 'replay'>('evidence')
  const query = useQuery({ queryKey: ['pricing', workspace, 'log-cost', id], queryFn: ({ signal }) => request<PricingLogCost>(`/logs/${encodeURIComponent(id)}/cost-breakdown`, undefined, 'GET', signal), enabled: /^\d+$/.test(id) })
  const refresh = () => { void client.invalidateQueries({ queryKey: ['pricing', workspace, 'log-cost', id] }); void client.invalidateQueries({ queryKey: ['logs'] }); void client.invalidateQueries({ queryKey: ['logs-summary'] }) }
  const document = query.data
  const ledger = document && 'attempts' in document ? document : null
  return <div className="space-y-5">
    <PageHeader title={t('cost.title')} description={t('cost.help')} icon={ReceiptText}><Link to="/logs" className={buttonVariants({ variant: 'outline' })}><ArrowLeft className="h-4 w-4" />{t('cost.back')}</Link><Button variant="outline" onClick={refresh} disabled={query.isFetching}><RefreshCw className="h-4 w-4" />{t('refresh')}</Button></PageHeader>
    {query.isLoading ? <SkeletonCard /> : query.error || !document ? <CardStatic className="p-6"><p role="alert">{t(pricingErrorKey(query.error))}</p></CardStatic> : <>
      <CardStatic className="space-y-5 p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-[var(--foreground-muted)]">{t(ledger && document.amount === null ? 'simulation.knownSubtotal' : 'cost.upstream')}</p><p className="mt-2 text-2xl font-bold"><CostValue value={ledger ? document.amount ?? ledger.known_subtotal : document.amount} currency={document.report_currency} /></p></div><Badge variant={ledger && !ledger.unknown_attempts && !ledger.pending_attempts ? 'emerald' : 'amber'}>{t(`status.${document.status}`)}</Badge></div>
        <p className="text-xs leading-5 text-[var(--foreground-muted)]">{t(ledger ? 'cost.totalHelp' : document.status === 'unpriced' ? 'report.missingEvidence' : 'cost.legacy')}</p>
        <CostFacts items={[[t('cost.request'), <code>{document.request_id}</code>], [t('cost.time'), new Date(document.log.timestamp).toLocaleString(i18n.resolvedLanguage)], [t('cost.model'), <code>{document.log.model}</code>], [t('cost.node'), <code>{document.log.node_id}</code>], [t('cost.protocol'), <code>{document.log.source_format}</code>], [t('cost.http'), <code>{document.log.status_code}</code>]]} />
      </CardStatic>
      {ledger ? <>
        {canInspect && ledger.reservations.some((row) => row.recovery_case) && <CardStatic className="space-y-3 p-5"><p className="text-sm leading-6">{t('recovery.supplierWarning')}</p><Link className={buttonVariants({ variant: 'outline' })} to={`/pricing/recovery/${encodeURIComponent(ledger.reservations.find((row) => row.recovery_case)!.id)}`}>{t('recovery.openGroup')}</Link></CardStatic>}
        <CardStatic className="space-y-4 p-5"><CostFacts items={[[t('cost.budgetCommitted'), <CostValue value={ledger.budget_committed_usd} currency="USD" />], [t('cost.budgetReserved'), <CostValue value={ledger.budget_reserved_usd} currency="USD" />], [t('cost.attemptCount'), ledger.provider_attempts], [t('cost.unknownCount'), ledger.unknown_attempts], [t('cost.pendingCount'), ledger.pending_attempts], [t('cost.pendingCorrections'), ledger.pending_budget_adjustments]]} /><p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('cost.budgetHelp')}</p>
          {ledger.attempts.some((attempt) => attempt.fee_source === 'local_cache') && <LocalCacheAccounting ledger={ledger} log={document.log} />}
        </CardStatic>
        <div className="flex gap-2" role="group" aria-label={t('cost.sections')}>{(['evidence', 'replay'] as const).map((value) => <Button key={value} variant={tab === value ? 'secondary' : 'outline'} aria-pressed={tab === value} onClick={() => setTab(value)}>{t(`cost.tab.${value}`)}</Button>)}</div>
        {tab === 'evidence' ? <RequestCostEvidence workspace={workspace} ledger={ledger} canManage={canManage} canInspect={canInspect} onRefresh={refresh} /> : <Suspense fallback={<SkeletonCard />}><RequestCostReplay workspace={workspace} requestId={ledger.request_id} /></Suspense>}
      </> : null}
    </>}
  </div>
}

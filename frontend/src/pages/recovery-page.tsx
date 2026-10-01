import { waitForRecoveryBasis } from '@/lib/recovery-view-state'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ClipboardCheck, RefreshCw, ArrowRight } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, buttonVariants } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { SkeletonCard } from '@/components/ui/skeleton'
import { hasWorkspaceRole, useWorkspaces } from '@/hooks/use-workspaces'
import { pricingClient } from '@/lib/pricing-client'
import { loadPendingRecovery } from '@/lib/recovery-form'
import { PricingNavigationGuard } from '@/components/pricing/pricing-navigation-guard'
import { pricingErrorKey } from '@/components/pricing/price-simulator'
import { CostValue } from '@/components/pricing/cost-metadata'
import { RecoveryEditor, RecoveryNotice } from '@/components/pricing/recovery-editor'
import type { RecoveryBasis, RecoveryInventoryPage, RecoveryView } from '@/types/pricing'

const views: RecoveryView[] = ['open', 'resolved', 'unresolved_cost', 'all']
export function RecoveryPage() {
  const { t } = useTranslation('pricing'), { id } = useParams(), [params] = useSearchParams()
  const { data, error, isLoading } = useWorkspaces()
  if (isLoading) return <SkeletonCard />
  if (error || !data) return <p role="alert">{t('error.workspace')}</p>
  if (!data.access || !hasWorkspaceRole(data.access, 'operator')) return <CardStatic className="space-y-4 p-6"><h1 className="text-xl font-semibold">{t('recovery.title')}</h1><p role="alert">{t('recovery.permission')}</p><Link to="/pricing" className={buttonVariants({ variant: 'outline' })}>{t('recovery.backPricing')}</Link></CardStatic>
  const view = views.includes(params.get('view') as RecoveryView) ? params.get('view') as RecoveryView : 'open'
  return <PricingNavigationGuard key={`${data.active_workspace.id}/${data.access.user_id}/${id ?? 'list'}`}><RecoveryScope workspace={data.active_workspace.id} actor={data.access.user_id} canManage={hasWorkspaceRole(data.access, 'admin')} id={id} view={view} /></PricingNavigationGuard>
}
function RecoveryScope({ workspace, actor, canManage, id, view }: { workspace: string; actor: string; canManage: boolean; id?: string; view: RecoveryView }) {
  const { t } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const status = useQuery({ queryKey: ['pricing', workspace, 'status'], queryFn: ({ signal }) => request<{ state: string; version: string }>('/status', undefined, 'GET', signal), staleTime: 60000, retry: false })
  if (status.isLoading) return <SkeletonCard />
  if (status.error) return <p role="alert">{t(pricingErrorKey(status.error))}</p>
  if (status.data?.state !== 'applied') return <CardStatic className="space-y-3 p-6"><h1 className="text-xl font-semibold">{t('schema.title')}</h1><p className="text-sm leading-6">{t('schema.help')}</p><code>{status.data?.version}</code></CardStatic>
  return id ? <RecoveryDetail workspace={workspace} actor={actor} id={id} canManage={canManage} /> : <RecoveryInventory key={`${workspace}/${view}`} workspace={workspace} view={view} />
}
function RecoveryInventory({ workspace, view }: { workspace: string; view: RecoveryView }) {
  const { t, i18n } = useTranslation('pricing'), [, setParams] = useSearchParams()
  const request = useMemo(() => pricingClient(workspace), [workspace])
  const [cursors, setCursors] = useState<Array<string | null>>([null]), [page, setPage] = useState(0)
  const cursor = cursors[page]
  const query = useQuery({ queryKey: ['pricing', workspace, 'recovery-inventory', view, cursor], queryFn: ({ signal }) => request<RecoveryInventoryPage>(`/recovery-inventory?${new URLSearchParams({ view, limit: '20', ...(cursor ? { cursor } : {}) })}`, undefined, 'GET', signal), retry: false })
  const next = () => { if (!query.data?.next_cursor) return; setCursors((old) => [...old.slice(0, page + 1), query.data!.next_cursor]); setPage((value) => value + 1) }
  return <div className="space-y-5">
    <PageHeader title={t('recovery.title')} description={t('recovery.description')} icon={ClipboardCheck}><Link to="/pricing" className={buttonVariants({ variant: 'outline' })}><ArrowLeft className="h-4 w-4" />{t('recovery.backPricing')}</Link><Button variant="outline" disabled={query.isFetching} onClick={() => { setPage(0); setCursors([null]); void query.refetch() }}><RefreshCw className="h-4 w-4" />{t('refresh')}</Button></PageHeader>
    <RecoveryNotice /><Link to="/pricing/outcomes" className={buttonVariants({ variant: 'outline' })}>{t('disposition.title')}</Link>
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('recovery.views')}>{views.map((item) => <Button key={item} variant={view === item ? 'secondary' : 'outline'} aria-pressed={view === item} onClick={() => setParams({ view: item })}>{t(`recovery.view.${item}`)}</Button>)}</div>
    <p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('recovery.inventoryScope')}</p>
    {query.error ? <CardStatic className="p-5"><p role="alert">{t(pricingErrorKey(query.error))}</p></CardStatic> : query.isLoading ? <SkeletonCard /> : <CardStatic className="overflow-hidden">
      <div className="border-b border-[var(--border)] px-5 py-3 text-xs text-[var(--foreground-muted)]">{t('recovery.pageCount', { count: query.data?.items.length ?? 0, scanned: query.data?.scanned ?? 0 })}</div>
      {!query.data?.items.length ? <p className="p-6 text-sm leading-6">{t(query.data?.next_cursor ? 'recovery.emptyBatch' : 'recovery.empty')}</p> : <ul>{query.data.items.map((item) => <li key={item.reservation_id} className="grid min-w-0 gap-4 border-b border-[var(--border)] p-5 last:border-b-0 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div className="min-w-0"><p className="text-sm font-semibold">{t(`recovery.reason.${item.reason}`, { defaultValue: t('recovery.reason.other') })}</p><p className="mt-2 break-all font-mono text-xs">{item.request_id}</p><p className="mt-1 text-xs text-[var(--foreground-muted)]">{new Date(item.created_at).toLocaleString(i18n.resolvedLanguage)}</p></div>
        <div><p className="mb-2 text-xs text-[var(--foreground-muted)]">{t('recovery.budgetStatus')}</p><Badge variant={item.budget_state === 'reserved' ? 'amber' : 'zinc'}>{t(item.budget_state === 'reserved' ? 'recovery.budgetPending' : 'recovery.budgetHandled')}</Badge><p className="mt-2 text-xs">{t(item.budget_state === 'reserved' ? 'cost.budgetReserved' : 'cost.budgetCommitted')}: <CostValue value={item.budget_state === 'reserved' ? item.budget_reserved_usd : item.budget_committed_usd} currency="USD" /></p></div>
        <div><p className="mb-2 text-xs text-[var(--foreground-muted)]">{t('recovery.costStatus')}</p><Badge variant={item.supplier_state === 'known' ? 'zinc' : 'amber'}>{t(item.supplier_state === 'known' && item.request_cost_status ? `status.${item.request_cost_status}` : `recovery.supplier.${item.supplier_state}`)}</Badge>{item.supplier_state === 'known' && <p className="mt-1 text-xs text-[var(--foreground-muted)]">{t('recovery.supplier.known')}</p>}<p className="mt-2 text-xs"><CostValue value={item.request_amount_usd} currency="USD" /></p>{item.request_amount_usd === null && item.known_request_subtotal_usd !== null && <p className="mt-1 text-xs">{t('simulation.knownSubtotal')}: <CostValue value={item.known_request_subtotal_usd} currency="USD" /></p>}</div>
        <Link className={buttonVariants({ variant: 'outline', size: 'sm' })} to={`/pricing/recovery/${encodeURIComponent(item.reservation_id)}`}>{t('recovery.openGroup')}<ArrowRight className="h-3.5 w-3.5" /></Link>
      </li>)}</ul>}
      <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] p-3"><Button variant="ghost" disabled={query.isFetching || page === 0} onClick={() => setPage((value) => value - 1)}>{t('previous')}</Button><span className="text-xs text-[var(--foreground-muted)]">{page + 1}</span><Button variant="ghost" disabled={query.isFetching || !query.data?.next_cursor} onClick={next}>{t(view === 'unresolved_cost' ? 'recovery.scanNext' : 'next')}</Button></div>
    </CardStatic>}
  </div>
}
function RecoveryDetail({ workspace, actor, id, canManage }: { workspace: string; actor: string; id: string; canManage: boolean }) {
  const { t } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const [stored] = useState(() => { try { return { pending: loadPendingRecovery(sessionStorage, workspace, actor, id), error: false } } catch { return { pending: null, error: true } } })
  const query = useQuery({ queryKey: ['pricing', workspace, 'recovery-basis', id], queryFn: ({ signal }) => request<RecoveryBasis>(`/recovery-cases/${encodeURIComponent(id)}/basis`, undefined, 'GET', signal), retry: false, refetchOnWindowFocus: false })
  // The editor captures its initial basis once. Wait for the first read even
  // with a saved submission, otherwise a fast reload freezes an empty group.
  // Keep a restored editor mounted while its failed basis query is refetched.
  if (waitForRecoveryBasis(query, Boolean(stored.pending))) return <SkeletonCard />
  if (!stored.pending && !query.data) return <CardStatic className="space-y-4 p-6"><p role="alert">{t(pricingErrorKey(query.error))}</p><Link className={buttonVariants({ variant: 'outline' })} to="/pricing/recovery">{t('recovery.back')}</Link></CardStatic>
  return <RecoveryEditor workspace={workspace} actor={actor} anchor={id} canManage={canManage} initial={query.data ?? { anchor_reservation_id: id, basis_hash: stored.pending!.proposal.expected_basis_hash, budget_only: true, request_ids: [], reservations: [], attempts: [] }} pending={stored.pending} storageInvalid={stored.error} />
}

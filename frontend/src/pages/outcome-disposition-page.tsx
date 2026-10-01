import { waitForRecoveryBasis } from '@/lib/recovery-view-state'
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Archive, ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CardStatic } from '@/components/ui/card'
import { SkeletonCard } from '@/components/ui/skeleton'
import { hasWorkspaceRole, useWorkspaces } from '@/hooks/use-workspaces'
import { pricingClient } from '@/lib/pricing-client'
import { loadPendingDisposition, validateDispositionBasis } from '@/lib/outcome-disposition-form'
import { PricingNavigationGuard } from '@/components/pricing/pricing-navigation-guard'
import { pricingErrorKey } from '@/components/pricing/price-simulator'
import { OutcomeDispositionEditor, OutcomeDispositionNotice } from '@/components/pricing/outcome-disposition-editor'
import type { OutcomeDispositionBasis, RuntimeOutcomeState, RuntimeOutcomeSummary } from '@/types/pricing'

interface Inventory { items: RuntimeOutcomeSummary[]; state: RuntimeOutcomeState; limit: number; read_only: boolean; supplier_confirmed: false; coverage: string; next_cursor: string | null }
const states: RuntimeOutcomeState[] = ['review_required','pending','delivered']
export function OutcomeDispositionPage() {
  const { t } = useTranslation('pricing'), { id } = useParams(), [params] = useSearchParams(), { data, isLoading, error } = useWorkspaces()
  if (isLoading) return <SkeletonCard />
  if (error || !data) return <p role="alert">{t('error.workspace')}</p>
  if (!data.access || !hasWorkspaceRole(data.access,'operator')) return <CardStatic className="space-y-4 p-6"><h1 className="text-xl font-semibold">{t('disposition.title')}</h1><p role="alert">{t('recovery.permission')}</p><Link to="/pricing" className={buttonVariants({variant:'outline'})}>{t('recovery.backPricing')}</Link></CardStatic>
  const state = states.includes(params.get('state') as RuntimeOutcomeState) ? params.get('state') as RuntimeOutcomeState : 'review_required'
  return <PricingNavigationGuard key={`${data.active_workspace.id}/${data.access.user_id}/${id ?? 'list'}`}>{id ? <DispositionDetail workspace={data.active_workspace.id} actor={data.access.user_id} id={id} canManage={hasWorkspaceRole(data.access,'admin')} /> : <DispositionInventory key={`${data.active_workspace.id}/${state}`} workspace={data.active_workspace.id} state={state} />}</PricingNavigationGuard>
}
function DispositionInventory({ workspace, state }: { workspace: string; state: RuntimeOutcomeState }) {
  const { t, i18n } = useTranslation('pricing'), [,setParams] = useSearchParams(), cache = useQueryClient(), request = useMemo(()=>pricingClient(workspace),[workspace])
  const [cursors,setCursors] = useState<Array<string|null>>([null]), [page,setPage] = useState(0), cursor = cursors[page]
  const status = useQuery({ queryKey:['pricing',workspace,'status'],queryFn:({signal})=>request<{state:string;version:string}>('/status',undefined,'GET',signal),retry:false })
  const query = useQuery({queryKey:['pricing',workspace,'outcome-inventory',state,cursor],queryFn:async({signal})=>{
    const value = await request<Inventory>(`/runtime-outcomes?${new URLSearchParams({state,limit:'20',...(cursor?{cursor}:{})})}`,undefined,'GET',signal)
    if (!value || value.state !== state || value.read_only !== true || value.supplier_confirmed !== false || value.coverage !== 'retained_runtime_outcomes' || !Array.isArray(value.items) || value.items.length > 20 || value.items.some(row=>row.workspace_id!==workspace||row.state!==state||row.id!==`runtime-outcome:${row.outcome_hash}`) || (value.next_cursor!==null && (typeof value.next_cursor!=='string'||value.next_cursor.length>2048))) throw new Error('invalid_outcome_disposition')
    return value
  },enabled:status.data?.state==='applied',retry:false})
  const refresh = () => { setPage(0);setCursors([null]);void cache.invalidateQueries({queryKey:['pricing',workspace,'outcome-inventory']}) }
  const error = query.error ?? status.error
  return <div className="space-y-5"><PageHeader title={t('disposition.title')} description={t('disposition.description')} icon={Archive}><Link to="/pricing" className={buttonVariants({variant:'outline'})}><ArrowLeft className="h-4 w-4" />{t('recovery.backPricing')}</Link><Button variant="outline" disabled={query.isFetching} onClick={refresh}><RefreshCw className="h-4 w-4" />{t('refresh')}</Button></PageHeader><OutcomeDispositionNotice />
    <div role="group" aria-label={t('disposition.states')} className="flex flex-wrap gap-2">{states.map(value=><Button key={value} variant={state===value?'secondary':'outline'} aria-pressed={state===value} onClick={()=>setParams({state:value})}>{t(`disposition.state.${value}`)}</Button>)}</div>
    <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('disposition.inventoryHelp')}</p>
    {error ? <p role="alert">{t(pricingErrorKey(error))}</p> : status.isLoading || query.isLoading ? <SkeletonCard /> : status.data?.state!=='applied' ? <CardStatic className="space-y-3 p-6"><h2>{t('schema.title')}</h2><p>{t('schema.help')}</p><code>{status.data?.version}</code></CardStatic> : <CardStatic className="overflow-hidden"><ul>{query.data?.items.map(row=><li key={row.id} className="grid min-w-0 gap-4 border-b border-[var(--border)] p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"><div className="min-w-0 space-y-2"><Badge variant="zinc">{t(`disposition.kind.${row.kind}`)}</Badge><p className="break-all font-mono text-xs">{row.request_id}</p><p className="break-all font-mono text-xs text-[var(--foreground-muted)]">{row.id}</p><p className="text-xs">{new Date(row.created_at).toLocaleString(i18n.resolvedLanguage)}</p></div><div className="space-y-2"><p className="text-xs text-[var(--foreground-muted)]">{t('disposition.decision')}</p><Badge variant={row.disposition?'zinc':'amber'}>{row.disposition?t(`disposition.decision.${row.disposition.action}`):t('disposition.undecided')}</Badge>{row.disposition&&<p className="break-all font-mono text-xs">{row.disposition.id}</p>}<p className="text-xs leading-6 text-[var(--foreground-muted)]">{t(`disposition.stateHelp.${row.state}`)}</p></div><Link to={`/pricing/outcomes/${encodeURIComponent(row.id)}`} className={buttonVariants({variant:'outline',size:'sm'})}>{t('disposition.open')}<ArrowRight className="h-4 w-4" /></Link></li>)}</ul>{!query.data?.items.length&&<p className="p-6 text-sm">{t('disposition.empty')}</p>}<div className="flex justify-between gap-3 p-3"><Button variant="ghost" disabled={page===0||query.isFetching} onClick={()=>setPage(value=>value-1)}>{t('previous')}</Button><span className="text-xs">{page+1}</span><Button variant="ghost" disabled={!query.data?.next_cursor||query.isFetching} onClick={()=>{setCursors(old=>[...old.slice(0,page+1),query.data!.next_cursor]);setPage(value=>value+1)}}>{t('next')}</Button></div></CardStatic>}
  </div>
}
function DispositionDetail({workspace,actor,id,canManage}:{workspace:string;actor:string;id:string;canManage:boolean}) {
  const {t}=useTranslation('pricing'),request=useMemo(()=>pricingClient(workspace),[workspace])
  const [stored]=useState(()=>{try{return {pending:loadPendingDisposition(sessionStorage,workspace,actor,id),error:false}}catch{return {pending:null,error:true}}})
  const query=useQuery({queryKey:['pricing',workspace,'outcome-disposition-basis',id],queryFn:async({signal})=>validateDispositionBasis(await request<OutcomeDispositionBasis>(`/runtime-outcomes/${encodeURIComponent(id)}/disposition-basis`,undefined,'GET',signal),id),retry:false,refetchOnWindowFocus:false})
  // A pending proposal owns its editor even while a failed basis read refetches.
  if(waitForRecoveryBasis(query,Boolean(stored.pending)))return <SkeletonCard />
  if(!query.data&&!stored.pending)return <CardStatic className="space-y-4 p-6"><p role="alert">{t(query.error instanceof Error&&query.error.message==='invalid_outcome_disposition'?'usageRecovery.invalidReply':pricingErrorKey(query.error))}</p><Link to="/pricing/outcomes" className={buttonVariants({variant:'outline'})}>{t('disposition.back')}</Link></CardStatic>
  return <OutcomeDispositionEditor workspace={workspace} actor={actor} outcomeId={id} initial={query.data??null} pending={stored.pending} storageInvalid={stored.error} canManage={canManage} />
}

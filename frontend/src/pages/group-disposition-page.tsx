import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Layers, ArrowLeft, ArrowRight, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CardStatic } from '@/components/ui/card'
import { SkeletonCard } from '@/components/ui/skeleton'
import { hasWorkspaceRole, useWorkspaces } from '@/hooks/use-workspaces'
import { pricingClient } from '@/lib/pricing-client'
import {
  loadPendingGroupDisposition,
  validateGroupDispositionBasis
} from '@/lib/group-disposition-form'
import { waitForRecoveryBasis } from '@/lib/recovery-view-state'
import { PricingNavigationGuard } from '@/components/pricing/pricing-navigation-guard'
import { pricingErrorKey } from '@/components/pricing/price-simulator'
import {
  GroupDispositionEditor,
  GroupDispositionNotice
} from '@/components/pricing/group-disposition-editor'
import type { GroupDispositionBasis, GroupOutcomeRow, GroupOutcomeState } from '@/types/pricing'

type Row = Omit<GroupOutcomeRow, 'document_json'> & {
  disposition: GroupDispositionBasis['disposition']
}
interface Inventory {
  items: Row[]
  read_only: true
  supplier_confirmed: false
  next_cursor: string | null
}
const states: GroupOutcomeState[] = ['review_required', 'pending', 'delivered']
export function GroupDispositionPage() {
  const { t } = useTranslation('pricing'),
    { id } = useParams(),
    [params] = useSearchParams(),
    { data, isLoading, error } = useWorkspaces()
  if (isLoading) return <SkeletonCard />
  if (error || !data) return <p role="alert">{t('error.workspace')}</p>
  if (!data.access || !hasWorkspaceRole(data.access, 'operator'))
    return (
      <CardStatic className="space-y-4 p-6">
        <h1 className="text-xl font-semibold">{t('groupDisposition.title')}</h1>
        <p role="alert">{t('recovery.permission')}</p>
        <Link to="/pricing" className={buttonVariants({ variant: 'outline' })}>
          {t('recovery.backPricing')}
        </Link>
      </CardStatic>
    )
  const state = states.includes(params.get('state') as GroupOutcomeState)
    ? (params.get('state') as GroupOutcomeState)
    : 'review_required'
  return (
    <PricingNavigationGuard
      key={`${data.active_workspace.id}/${data.access.user_id}/${id ?? 'list'}`}
    >
      {id ? (
        <GroupDetail
          workspace={data.active_workspace.id}
          actor={data.access.user_id}
          id={id}
          canManage={hasWorkspaceRole(data.access, 'admin')}
        />
      ) : (
        <GroupInventory
          key={`${data.active_workspace.id}/${state}`}
          workspace={data.active_workspace.id}
          state={state}
        />
      )}
    </PricingNavigationGuard>
  )
}
function GroupInventory({ workspace, state }: { workspace: string; state: GroupOutcomeState }) {
  const { t, i18n } = useTranslation('pricing'),
    [, setParams] = useSearchParams(),
    cache = useQueryClient(),
    request = useMemo(() => pricingClient(workspace), [workspace])
  const [cursors, setCursors] = useState<Array<string | null>>([null]),
    [page, setPage] = useState(0),
    cursor = cursors[page]
  const status = useQuery({
    queryKey: ['pricing', workspace, 'status'],
    queryFn: ({ signal }) =>
      request<{ state: string; version: string }>('/status', undefined, 'GET', signal),
    retry: false
  })
  const query = useQuery({
    queryKey: ['pricing', workspace, 'group-outcome-inventory', state, cursor],
    queryFn: async ({ signal }) => {
      const value = await request<Inventory>(
        `/runtime-group-outcomes?${new URLSearchParams({ state, limit: '20', ...(cursor ? { cursor } : {}) })}`,
        undefined,
        'GET',
        signal
      )
      if (
        !value ||
        value.read_only !== true ||
        value.supplier_confirmed !== false ||
        !Array.isArray(value.items) ||
        value.items.length > 20 ||
        new Set(value.items.map((row) => row.id)).size !== value.items.length ||
        (value.next_cursor !== null &&
          (typeof value.next_cursor !== 'string' || value.next_cursor.length > 2048))
      )
        throw new Error('invalid_group_disposition')
      for (const row of value.items)
        if (
          row.workspace_id !== workspace ||
          row.state !== state ||
          row.id !== `runtime-group:${row.document_hash}` ||
          !/^[a-f0-9]{64}$/.test(row.document_hash) ||
          !['attempt_group', 'settlement_group', 'actual_budget_closure_group'].includes(row.kind) ||
          !Number.isSafeInteger(row.member_count) ||
          row.member_count < 1 ||
          row.member_count > 4096 ||
          !Number.isFinite(Date.parse(row.created_at)) ||
          (row.disposition &&
            (!['accept_receipts', 'reject_evidence'].includes(row.disposition.action) ||
              typeof row.disposition.id !== 'string' ||
              typeof row.disposition.actor_id !== 'string' ||
              !/^[a-f0-9]{64}$/.test(row.disposition.result_hash)))
        )
          throw new Error('invalid_group_disposition')
      return value
    },
    enabled: status.data?.state === 'applied',
    retry: false
  })
  const refresh = () => {
      setPage(0)
      setCursors([null])
      void cache.invalidateQueries({ queryKey: ['pricing', workspace, 'group-outcome-inventory'] })
    },
    error = query.error ?? status.error
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('groupDisposition.title')}
        description={t('groupDisposition.description')}
        icon={Layers}
      >
        <Link to="/pricing" className={buttonVariants({ variant: 'outline' })}>
          <ArrowLeft className="h-4 w-4" />
          {t('recovery.backPricing')}
        </Link>
        <Button variant="outline" disabled={query.isFetching} onClick={refresh}>
          <RefreshCw className="h-4 w-4" />
          {t('refresh')}
        </Button>
      </PageHeader>
      <GroupDispositionNotice />
      <div role="group" aria-label={t('disposition.states')} className="flex flex-wrap gap-2">
        {states.map((value) => (
          <Button
            key={value}
            variant={state === value ? 'secondary' : 'outline'}
            aria-pressed={state === value}
            onClick={() => setParams({ state: value })}
          >
            {t(`disposition.state.${value}`)}
          </Button>
        ))}
      </div>
      <p className="text-xs leading-6 text-[var(--foreground-muted)]">
        {t('groupDisposition.inventoryHelp')}
      </p>
      {error ? (
        <p role="alert">{t(pricingErrorKey(error))}</p>
      ) : status.isLoading || query.isLoading ? (
        <SkeletonCard />
      ) : status.data?.state !== 'applied' ? (
        <CardStatic className="space-y-3 p-6">
          <h2>{t('schema.title')}</h2>
          <p>{t('schema.help')}</p>
          <code>{status.data?.version}</code>
        </CardStatic>
      ) : (
        <CardStatic className="overflow-hidden">
          <ul>
            {query.data?.items.map((row) => (
              <li
                key={row.id}
                className="grid min-w-0 gap-4 border-b border-[var(--border)] p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
              >
                <div className="min-w-0 space-y-2">
                  <Badge variant="zinc">{t(`groupDisposition.kind.${row.kind}`)}</Badge>
                  <p className="break-all font-mono text-xs">{row.id}</p>
                  <p className="text-xs">
                    {t('groupDisposition.rosterCount', { count: row.member_count })}
                  </p>
                  <p className="text-xs text-[var(--foreground-muted)]">
                    {new Date(row.created_at).toLocaleString(i18n.resolvedLanguage)}
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="text-xs text-[var(--foreground-muted)]">
                    {t('disposition.decision')}
                  </p>
                  <Badge variant={row.disposition ? 'zinc' : 'amber'}>
                    {row.disposition
                      ? t(`disposition.decision.${row.disposition.action}`)
                      : t('disposition.undecided')}
                  </Badge>
                  {row.disposition && (
                    <p className="break-all font-mono text-xs">{row.disposition.id}</p>
                  )}
                  <p className="text-xs leading-6 text-[var(--foreground-muted)]">
                    {t(`disposition.stateHelp.${row.state}`)}
                  </p>
                </div>
                <Link
                  to={`/pricing/group-outcomes/${encodeURIComponent(row.id)}`}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  {t('disposition.open')}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </li>
            ))}
          </ul>
          {!query.data?.items.length && (
            <p className="p-6 text-sm">{t('groupDisposition.empty')}</p>
          )}
          <nav
            aria-label={t('groupDisposition.inventoryPages')}
            className="flex justify-between gap-3 p-3"
          >
            <Button
              variant="ghost"
              disabled={!page || query.isFetching}
              onClick={() => setPage((value) => value - 1)}
            >
              {t('previous')}
            </Button>
            <span className="text-xs">{page + 1}</span>
            <Button
              variant="ghost"
              disabled={!query.data?.next_cursor || query.isFetching}
              onClick={() => {
                setCursors((old) => [...old.slice(0, page + 1), query.data!.next_cursor])
                setPage((value) => value + 1)
              }}
            >
              {t('next')}
            </Button>
          </nav>
        </CardStatic>
      )}
    </div>
  )
}
function GroupDetail({
  workspace,
  actor,
  id,
  canManage
}: {
  workspace: string
  actor: string
  id: string
  canManage: boolean
}) {
  const { t } = useTranslation('pricing'),
    request = useMemo(() => pricingClient(workspace), [workspace])
  const [stored] = useState(() => {
    try {
      return {
        pending: loadPendingGroupDisposition(sessionStorage, workspace, actor, id),
        error: false
      }
    } catch {
      return { pending: null, error: true }
    }
  })
  const query = useQuery({
    queryKey: ['pricing', workspace, 'group-disposition-basis', id],
    queryFn: async ({ signal }) =>
      validateGroupDispositionBasis(
        await request<GroupDispositionBasis>(
          `/runtime-group-outcomes/${encodeURIComponent(id)}/disposition-basis`,
          undefined,
          'GET',
          signal
        ),
        id
      ),
    retry: false,
    refetchOnWindowFocus: false
  })
  if (waitForRecoveryBasis(query, Boolean(stored.pending))) return <SkeletonCard />
  if (!query.data && !stored.pending)
    return (
      <CardStatic className="space-y-4 p-6">
        <p role="alert">
          {t(
            query.error instanceof Error && query.error.message === 'invalid_group_disposition'
              ? 'usageRecovery.invalidReply'
              : pricingErrorKey(query.error)
          )}
        </p>
        <Link to="/pricing/group-outcomes" className={buttonVariants({ variant: 'outline' })}>
          {t('groupDisposition.back')}
        </Link>
      </CardStatic>
    )
  return (
    <GroupDispositionEditor
      workspace={workspace}
      actor={actor}
      outcomeId={id}
      initial={query.data ?? null}
      pending={stored.pending}
      storageInvalid={stored.error}
      canManage={canManage}
    />
  )
}

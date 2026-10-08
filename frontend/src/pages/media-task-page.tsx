import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Film } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, buttonVariants } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { SkeletonCard } from '@/components/ui/skeleton'
import {
  MediaWorkspace,
  MediaError,
  MediaPager,
  useMediaInventory,
  type MediaWorkspaceContext,
} from '@/components/pricing/media-workspace'
import { MediaLookupEditor } from '@/components/pricing/media-lookup-editor'
import { MediaTaskStatus } from '@/components/pricing/media-task-status'
import { CostFacts, CostValue } from '@/components/pricing/cost-metadata'
import { PriceCostBreakdown } from '@/components/pricing/price-simulator'
import { HistoricalPriceSource } from '@/components/pricing/historical-price-source'
import { pricingClient } from '@/lib/pricing-client'
import { mediaTaskSubtotalKey } from '@/lib/media-task-status'
import { loadLookup, verifyLookupBasis } from '@/lib/media-operator-form'
import { costHash } from '@/lib/usage-recovery-form'
import type {
  CostLedgerSummary,
  MediaLookupBasis,
  MediaTaskSummary,
  MediaSupplierDecision,
} from '@/types/pricing'

interface EventSummary {
  id: string
  event_id: string
  decision: MediaSupplierDecision
  origin: 'authenticated_connector' | 'unversioned_observation'
  sequence: string | null
  document_hash: string
  created_at: string
  source_id: string
  supplier_invoice_confirmed: false
  disposition?: { id: string; action: 'accept' | 'reject'; actor_id: string; record_hash: string } | null
}
export function MediaTaskPage() {
  const { id } = useParams()
  return (
    <MediaWorkspace>
      {(context) =>
        id ? (
          <MediaTaskDetail key={`${context.workspace}/${context.actor}/${id}`} {...context} id={id} />
        ) : null
      }
    </MediaWorkspace>
  )
}
function MediaTaskDetail({ workspace, actor, canManage, id }: MediaWorkspaceContext & { id: string }) {
  const { t, i18n } = useTranslation('pricing'),
    request = useMemo(() => pricingClient(workspace), [workspace]),
    prefix = `/media-tasks/${encodeURIComponent(id)}`
  const detail = useQuery({
    queryKey: ['pricing', workspace, 'media-task', id],
    queryFn: async ({ signal }) => {
      const value = await request<{ task: MediaTaskSummary; ledger: CostLedgerSummary | null }>(
        prefix,
        undefined,
        'GET',
        signal,
      )
      if (value.task?.id !== id || value.task.workspace_id !== workspace)
        throw Error('invalid_media_response')
      return value
    },
    retry: false,
    refetchOnWindowFocus: false,
  })
  const basis = useQuery({
    queryKey: ['pricing', workspace, 'media-lookup-basis', id],
    queryFn: async ({ signal }) =>
      verifyLookupBasis(
        await request<MediaLookupBasis>(`${prefix}/job-lookup-basis`, undefined, 'GET', signal),
        workspace,
        id,
      ),
    retry: false,
    refetchOnWindowFocus: false,
  })
  const [restoreNeeded] = useState(() => {try {return Boolean(loadLookup(sessionStorage,workspace,actor,id))} catch {return true}})
  const refresh = () => {
    void detail.refetch()
  }
  return (
    <div className="space-y-5">
      <PageHeader title={t('mediaOps.taskDetail')} description={id} icon={Film}>
        <Link to="/pricing/media" className={buttonVariants({ variant: 'outline' })}>
          {t('mediaOps.back')}
        </Link>
        <Button variant="outline" disabled={detail.isFetching} onClick={refresh}>
          {t('refresh')}
        </Button>
      </PageHeader>
      {detail.error && <MediaError error={detail.error} />}{' '}
      {detail.data && (
        <CardStatic className="space-y-4 p-5">
          <MediaTaskStatus task={detail.data.task} />
          <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('mediaOps.statusHelp')}</p>
          <CostFacts
            items={[
              [t('mediaOps.deliveryState'), t('mediaOps.deliveryUntracked')],
              [t('mediaOps.jobId'), <code>{detail.data.task.provider_job_id ?? t('mediaOps.noJob')}</code>],
              [t('publish.node'), <code>{detail.data.task.node_id}</code>],
              [t('publish.model'), <code>{detail.data.task.model}</code>],
              [t('mediaOps.credential'), <code>{detail.data.task.credential_id ?? '—'}</code>],
              [
                t('cost.completed'),
                detail.data.task.terminal_at
                  ? new Date(detail.data.task.terminal_at).toLocaleString(i18n.resolvedLanguage)
                  : '—',
              ],
            ]}
          />
          {detail.data.ledger && (
            <>
              <p className="text-xs">{t('mediaOps.ledgerHelp')}</p>
              <CostFacts
                items={[
                  [t('simulation.total'), <CostValue value={detail.data.ledger.amount} currency="USD" />],
                  [
                    t(mediaTaskSubtotalKey(detail.data.ledger.amount)),
                    <CostValue value={detail.data.ledger.known_subtotal} currency="USD" />,
                  ],
                  [
                    t('cost.budgetReserved'),
                    <CostValue value={detail.data.ledger.budget_reserved_usd} currency="USD" />,
                  ],
                  [
                    t('cost.budgetCommitted'),
                    <CostValue value={detail.data.ledger.budget_committed_usd} currency="USD" />,
                  ],
                ]}
              />
              {detail.data.ledger.attempts.map((attempt) => {
                const cost = attempt.effective_cost ?? attempt.cost
                return cost ? (
                  <details key={attempt.id}>
                    <summary className="cursor-pointer text-sm font-semibold">
                      {t('mediaOps.recordedCost')} · {attempt.id}
                    </summary>
                    <div className="mt-4 space-y-4">
                      <PriceCostBreakdown cost={cost} title={t('mediaOps.recordedCost')} />
                      <HistoricalPriceSource workspace={workspace} cost={cost} />
                    </div>
                  </details>
                ) : null
              })}
            </>
          )}
        </CardStatic>
      )}
      {basis.isPending && !restoreNeeded ? (
        <SkeletonCard />
      ) : (
        <MediaLookupEditor
          workspace={workspace}
          actor={actor}
          task={id}
          canManage={canManage}
          basis={basis.data}
          basisError={basis.error}
          onRefresh={refresh}
        />
      )}
      <MediaEventInventory key={`${workspace}/${id}`} workspace={workspace} id={id} />
    </div>
  )
}
function MediaEventInventory({ workspace, id }: { workspace: string; id: string }) {
  const { t, i18n } = useTranslation('pricing'),
    [selected, setSelected] = useState<EventSummary | null>(null),
    request = useMemo(() => pricingClient(workspace), [workspace]),
    prefix = `/media-tasks/${encodeURIComponent(id)}/supplier-events`,
    pagination = useMediaInventory<{ events: EventSummary[] }>(workspace, prefix, `events:${id}`),
    { query } = pagination
  const event = useQuery({
    queryKey: ['pricing', workspace, 'media-event', id, selected?.id],
    queryFn: async ({ signal }) => {
      const value = await request<EventSummary & { document: unknown; task_id: string }>(
        `${prefix}/${encodeURIComponent(selected!.id)}`,
        undefined,
        'GET',
        signal,
      )
      if (
        value.task_id !== id ||
        value.id !== selected!.id ||
        value.document_hash !== selected!.document_hash ||
        (await costHash(value.document)) !== value.document_hash
      )
        throw Error('invalid_media_response')
      return value
    },
    enabled: Boolean(selected),
    retry: false,
  })
  return (
    <CardStatic className="space-y-4 p-5">
      <div className="flex flex-wrap justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('mediaOps.events')}</h2>
        <Button variant="ghost" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {t('refresh')}
        </Button>
      </div>
      <p className="text-xs leading-6">{t('mediaOps.eventHelp')}</p>
      {query.error && <MediaError error={query.error} />}
      <ul className="divide-y divide-[var(--border)]">
        {query.data?.events.map((row) => (
          <li key={row.id} className="py-3">
            <button type="button" onClick={() => setSelected(row)} className="w-full space-y-2 text-left">
              <p className="break-all text-sm font-semibold">
                {t(`mediaOps.decision.${row.decision}`)} · {row.event_id}
              </p>
              {row.disposition && <p className="text-xs">{t('mediaDisposition.recorded')} · {t(`mediaDisposition.action.${row.disposition.action}`)}</p>}
              <p className="text-xs text-[var(--foreground-muted)]">
                {t(`mediaOps.origin.${row.origin}`)} · {t('mediaOps.sequence')}: {row.sequence ?? '—'} ·{' '}
                {new Date(row.created_at).toLocaleString(i18n.resolvedLanguage)}
              </p>
            </button>
          </li>
        ))}
      </ul>
      {query.isPending ? (
        <SkeletonCard />
      ) : (
        !query.data?.events.length && <p className="text-sm">{t('mediaOps.noEvents')}</p>
      )}
      <MediaPager {...pagination} busy={query.isFetching} hasMore={Boolean(query.data?.next_cursor)} />
      {selected && (
        <section className="space-y-3 border-t border-[var(--border)] pt-4">
          <h3 className="font-semibold">{t('mediaOps.eventDetail')}</h3>
          {selected.decision === 'review_required' && <Link to={`/pricing/media/${encodeURIComponent(id)}/events/${encodeURIComponent(selected.id)}`} className={buttonVariants({ variant: 'outline' })}>{t('mediaDisposition.open')}</Link>}
          {event.error && <MediaError error={event.error} />}{' '}
          {event.data && (
            <>
              <code className="block break-all text-xs">{event.data.document_hash}</code>
              <p className="text-xs">{t('mediaOps.normalizedOnly')}</p>
              <pre
                className="max-h-80 overflow-auto rounded-lg bg-[var(--background)] p-3 text-xs"
                tabIndex={0}
              >
                {JSON.stringify(event.data.document, null, 2)}
              </pre>
            </>
          )}
        </section>
      )}
    </CardStatic>
  )
}

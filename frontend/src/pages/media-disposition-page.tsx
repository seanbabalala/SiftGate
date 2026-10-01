import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ClipboardCheck } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { buttonVariants } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { SkeletonCard } from '@/components/ui/skeleton'
import { MediaWorkspace, MediaError, type MediaWorkspaceContext } from '@/components/pricing/media-workspace'
import { MediaDispositionEditor, MediaDispositionImpact } from '@/components/pricing/media-disposition-editor'
import { pricingClient } from '@/lib/pricing-client'
import { loadMediaDisposition, verifyMediaDispositionBasis, verifyMediaDispositionReceipt } from '@/lib/media-disposition-form'
import type { MediaEventDispositionBasis, MediaEventDispositionReceipt } from '@/types/pricing'

export function MediaDispositionPage() {
  const { id, eventId } = useParams()
  return <MediaWorkspace>{context => id && eventId ? <Detail key={`${context.workspace}/${context.actor}/${id}/${eventId}`} {...context} task={id} event={eventId} /> : null}</MediaWorkspace>
}
function Detail({ workspace, actor, canManage, task, event }: MediaWorkspaceContext & { task: string; event: string }) {
  const { t } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace]),
    prefix = `/media-tasks/${encodeURIComponent(task)}/supplier-events/${encodeURIComponent(event)}`
  const [restored] = useState(() => { try { return { pending: loadMediaDisposition(sessionStorage, workspace, actor, task, event), bad: false } } catch { return { pending: null, bad: true } } })
  const basis = useQuery({ queryKey: ['pricing', workspace, 'media-disposition', task, event],
    queryFn: async ({ signal }) => verifyMediaDispositionBasis(await request<MediaEventDispositionBasis>(`${prefix}/disposition-basis`, undefined, 'GET', signal), workspace, task, event), retry: false, refetchOnWindowFocus: false })
  const recorded = basis.data?.disposition
  const history = useQuery({ queryKey: ['pricing', workspace, 'media-disposition-receipt', task, event, recorded?.record_hash],
    queryFn: async ({ signal }) => {
      const value = await request<{ disposition: MediaEventDispositionReceipt }>(prefix, undefined, 'GET', signal)
      if (!recorded || value.disposition?.record_hash !== recorded.record_hash || value.disposition.id !== recorded.id) throw new Error('invalid_media_response')
      return verifyMediaDispositionReceipt(value.disposition, workspace, recorded.actor_id, task, event)
    }, enabled: Boolean(recorded && !restored.pending), retry: false, refetchOnWindowFocus: false })
  return <div className="space-y-5">
    <PageHeader title={t('mediaDisposition.title')} icon={ClipboardCheck}>
      <Link to={`/pricing/media/${encodeURIComponent(task)}`} className={buttonVariants({ variant: 'outline' })}>{t('mediaDisposition.back')}</Link>
    </PageHeader>
    <code className="block break-all text-xs text-[var(--foreground-muted)]">{event}</code>
    {basis.isPending && !restored.pending && !restored.bad ? <SkeletonCard /> : recorded && !restored.pending ?
      <CardStatic className="space-y-5 p-5"><p role="status">{t('mediaDisposition.recorded')} · {t(`mediaDisposition.action.${recorded.action}`)}</p>
        <p className="text-xs">{t('mediaDisposition.help')}</p><code className="block break-all text-xs">{recorded.actor_id} · {recorded.id}</code>
        {history.error && <MediaError error={history.error} />}{history.isPending && <SkeletonCard />}
        {history.data && <><p className="text-sm">{t('mediaOps.checkLedger')}</p><MediaDispositionImpact preview={history.data.preview} /></>}
      </CardStatic> : <MediaDispositionEditor workspace={workspace} actor={actor} task={task} event={event} canManage={canManage}
        initial={basis.data} basisError={basis.error} pending={restored.pending} storageInvalid={restored.bad} />}
  </div>
}

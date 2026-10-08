import { waitForRecoveryBasis } from '@/lib/recovery-view-state'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CardStatic } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { SkeletonCard } from '@/components/ui/skeleton'
import { PricingNavigationGuard } from '@/components/pricing/pricing-navigation-guard'
import { AttemptCorrectionEditor } from '@/components/pricing/attempt-correction-editor'
import { pricingErrorKey } from '@/components/pricing/price-simulator'
import { hasWorkspaceRole, useWorkspaces } from '@/hooks/use-workspaces'
import { loadPendingCorrection } from '@/lib/attempt-correction-form'
import { pricingClient } from '@/lib/pricing-client'
import type { AttemptCorrectionBasis } from '@/types/pricing'

export function AttemptCorrectionPage() {
  const { t } = useTranslation('pricing'), { id } = useParams(), { data, error, isLoading } = useWorkspaces()
  if (isLoading) return <SkeletonCard />
  if (error || !data || !id) return <p role="alert">{t('error.workspace')}</p>
  if (!data.access || !hasWorkspaceRole(data.access, 'operator')) return <CardStatic className="space-y-4 p-6"><h1 className="text-xl font-semibold">{t('attemptCorrection.title')}</h1><p role="alert">{t('recovery.permission')}</p><Link to="/logs" className={buttonVariants({ variant: 'outline' })}>{t('cost.back')}</Link></CardStatic>
  return <PricingNavigationGuard key={`${data.active_workspace.id}/${data.access.user_id}/${id}`}><CorrectionDetail workspace={data.active_workspace.id} actor={data.access.user_id} attemptId={id} canManage={hasWorkspaceRole(data.access, 'admin')} /></PricingNavigationGuard>
}
function CorrectionDetail({ workspace, actor, attemptId, canManage }: { workspace: string; actor: string; attemptId: string; canManage: boolean }) {
  const { t } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const [stored] = useState(() => { try { return { pending: loadPendingCorrection(sessionStorage, workspace, actor, attemptId), error: false } } catch { return { pending: null, error: true } } })
  const query = useQuery({ queryKey: ['pricing', workspace, 'attempt-correction-basis', attemptId], queryFn: ({ signal }) => request<AttemptCorrectionBasis>(`/attempts/${encodeURIComponent(attemptId)}/correction-basis`, undefined, 'GET', signal), retry: false, refetchOnWindowFocus: false })
  // Keep a restored editor mounted while its failed basis query is refetched.
  if (waitForRecoveryBasis(query, Boolean(stored.pending))) return <SkeletonCard />
  if (!stored.pending && !query.data) return <CardStatic className="space-y-4 p-6"><p role="alert">{t(pricingErrorKey(query.error))}</p><Link className={buttonVariants({ variant: 'outline' })} to="/logs">{t('cost.back')}</Link></CardStatic>
  return <AttemptCorrectionEditor workspace={workspace} actor={actor} attemptId={attemptId} initial={query.data ?? null} pending={stored.pending} storageInvalid={stored.error} canManage={canManage} />
}

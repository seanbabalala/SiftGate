import { waitForRecoveryBasis } from '@/lib/recovery-view-state'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CardStatic } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { SkeletonCard } from '@/components/ui/skeleton'
import { PricingNavigationGuard } from '@/components/pricing/pricing-navigation-guard'
import { UsageRecoveryEditor } from '@/components/pricing/usage-recovery-editor'
import { pricingErrorKey } from '@/components/pricing/price-simulator'
import { hasWorkspaceRole, useWorkspaces } from '@/hooks/use-workspaces'
import { loadPendingUsage } from '@/lib/usage-recovery-form'
import { pricingClient } from '@/lib/pricing-client'
import type { RecoveryBasis } from '@/types/pricing'

export function UsageRecoveryPage() {
  const { t } = useTranslation('pricing'), { id } = useParams(), { data, error, isLoading } = useWorkspaces()
  if (isLoading) return <SkeletonCard />
  if (error || !data || !id) return <p role="alert">{t('error.workspace')}</p>
  if (!data.access || !hasWorkspaceRole(data.access, 'operator')) return <CardStatic className="space-y-4 p-6"><h1 className="text-xl font-semibold">{t('usageRecovery.title')}</h1><p role="alert">{t('recovery.permission')}</p><Link to="/pricing" className={buttonVariants({ variant: 'outline' })}>{t('recovery.backPricing')}</Link></CardStatic>
  return <PricingNavigationGuard key={`${data.active_workspace.id}/${data.access.user_id}/${id}`}><UsageRecoveryDetail workspace={data.active_workspace.id} actor={data.access.user_id} anchor={id} canManage={hasWorkspaceRole(data.access, 'admin')} /></PricingNavigationGuard>
}
function UsageRecoveryDetail({ workspace, actor, anchor, canManage }: { workspace: string; actor: string; anchor: string; canManage: boolean }) {
  const { t } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const [stored] = useState(() => { try { return { pending: loadPendingUsage(sessionStorage, workspace, actor, anchor), error: false } } catch { return { pending: null, error: true } } })
  const query = useQuery({ queryKey: ['pricing', workspace, 'usage-recovery-basis', anchor], queryFn: ({ signal }) => request<RecoveryBasis>(`/recovery-cases/${encodeURIComponent(anchor)}/basis`, undefined, 'GET', signal), retry: false, refetchOnWindowFocus: false })
  // Keep a restored editor mounted while its failed basis query is refetched.
  if (waitForRecoveryBasis(query, Boolean(stored.pending))) return <SkeletonCard />
  if (!stored.pending && !query.data) return <CardStatic className="space-y-4 p-6"><p role="alert">{t(pricingErrorKey(query.error))}</p><Link to="/pricing/recovery" className={buttonVariants({ variant: 'outline' })}>{t('recovery.back')}</Link></CardStatic>
  return <UsageRecoveryEditor workspace={workspace} actor={actor} anchor={anchor} canManage={canManage} initial={query.data ?? { anchor_reservation_id: anchor, basis_hash: stored.pending!.proposal.expected_basis_hash, budget_only: true, request_ids: [], reservations: [], attempts: [] }} pending={stored.pending} storageInvalid={stored.error} />
}

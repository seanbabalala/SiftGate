import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Button, buttonVariants } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { SkeletonCard } from '@/components/ui/skeleton'
import { hasWorkspaceRole, useWorkspaces } from '@/hooks/use-workspaces'
import { pricingClient } from '@/lib/pricing-client'
import { verifyMediaPage } from '@/lib/media-operator-form'
import { PricingNavigationGuard } from './pricing-navigation-guard'
import { pricingErrorKey } from './price-simulator'

export interface MediaWorkspaceContext {
  workspace: string
  actor: string
  canManage: boolean
}
export function MediaWorkspace({ children }: { children: (context: MediaWorkspaceContext) => ReactNode }) {
  const { t } = useTranslation('pricing'),
    { data, error, isLoading } = useWorkspaces()
  if (isLoading) return <SkeletonCard />
  if (error || !data) return <p role="alert">{t('error.workspace')}</p>
  if (!data.access || !hasWorkspaceRole(data.access, 'operator'))
    return (
      <CardStatic className="space-y-4 p-6">
        <h1 className="text-xl font-semibold">{t('mediaOps.title')}</h1>
        <p role="alert">{t('recovery.permission')}</p>
        <Link to="/pricing" className={buttonVariants({ variant: 'outline' })}>
          {t('recovery.backPricing')}
        </Link>
      </CardStatic>
    )
  const context = {
    workspace: data.active_workspace.id,
    actor: data.access.user_id,
    canManage: hasWorkspaceRole(data.access, 'admin'),
  }
  return (
    <PricingNavigationGuard key={`${context.workspace}/${context.actor}`}>
      {children(context)}
    </PricingNavigationGuard>
  )
}
export function MediaError({ error }: { error: unknown }) {
  const { t } = useTranslation('pricing')
  return (
    <p role="alert" className="border-l-2 border-[var(--destructive)] pl-3 text-sm leading-6">
      {t(
        error instanceof Error && error.message === 'invalid_media_response'
          ? 'mediaOps.invalid'
          : pricingErrorKey(error),
      )}
    </p>
  )
}
export function useMediaInventory<T>(workspace: string, path: string, key: string) {
  const request = useMemo(() => pricingClient(workspace), [workspace]),
    [cursors, setCursors] = useState<Array<string | null>>([null]),
    [page, setPage] = useState(0)
  const query = useQuery({
    queryKey: ['pricing', workspace, 'media-inventory', key, cursors[page]],
    queryFn: async ({ signal }) => {
      const value = await request<T & { next_cursor: string | null }>(
        `${path}${path.includes('?') ? '&' : '?'}limit=20${cursors[page] ? `&cursor=${encodeURIComponent(cursors[page]!)}` : ''}`,
        undefined,
        'GET',
        signal,
      )
      return verifyMediaPage(value, key, workspace)
    },
    retry: false,
    refetchOnWindowFocus: false,
  })
  return {
    query,
    page,
    previous: () => setPage((p) => Math.max(0, p - 1)),
    next: () => {
      if (!query.data?.next_cursor) return
      setCursors((old) => [...old.slice(0, page + 1), query.data!.next_cursor])
      setPage(page + 1)
    },
  }
}
export function MediaPager({
  page,
  previous,
  next,
  hasMore,
  busy,
}: {
  page: number
  previous: () => void
  next: () => void
  hasMore: boolean
  busy: boolean
}) {
  const { t } = useTranslation('pricing')
  return (
    <nav className="flex items-center justify-between gap-3" aria-label={t('mediaOps.pages')}>
      <Button variant="ghost" disabled={!page || busy} onClick={previous}>
        {t('previous')}
      </Button>
      <span className="text-xs font-mono">{page + 1}</span>
      <Button variant="ghost" disabled={!hasMore || busy} onClick={next}>
        {t('next')}
      </Button>
    </nav>
  )
}

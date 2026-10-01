import { useSearchParams, Link } from 'react-router-dom'
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
} from '@/components/pricing/media-workspace'
import { PriceSelect } from '@/components/pricing/pricing-fields'
import { MediaTaskStatus } from '@/components/pricing/media-task-status'
import type { MediaTaskSummary, MediaTaskView } from '@/types/pricing'

const views: MediaTaskView[] = ['all', 'uncertain', 'pending', 'terminal', 'settled', 'review_required']
export function MediaTasksPage() {
  const [params] = useSearchParams(),
    view = views.includes(params.get('view') as MediaTaskView) ? (params.get('view') as MediaTaskView) : 'all'
  return (
    <MediaWorkspace>
      {(context) => (
        <MediaTaskInventory key={`${context.workspace}/${view}`} workspace={context.workspace} view={view} />
      )}
    </MediaWorkspace>
  )
}
function MediaTaskInventory({ workspace, view }: { workspace: string; view: MediaTaskView }) {
  const { t, i18n } = useTranslation('pricing'),
    [, setParams] = useSearchParams(),
    pagination = useMediaInventory<{ tasks: MediaTaskSummary[] }>(
      workspace,
      `/media-tasks?view=${view}`,
      `tasks:${view}`,
    ),
    { query } = pagination
  return (
    <div className="space-y-5">
      <PageHeader title={t('mediaOps.title')} description={t('mediaOps.inventoryHelp')} icon={Film}>
        <Link to="/pricing/media-sources" className={buttonVariants({ variant: 'outline' })}>
          {t('mediaOps.sources')}
        </Link>
        <Link to="/pricing" className={buttonVariants({ variant: 'ghost' })}>
          {t('recovery.backPricing')}
        </Link>
        <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {t('refresh')}
        </Button>
      </PageHeader>
      <div className="max-w-sm">
        <PriceSelect
          label={t('mediaOps.view')}
          value={view}
          options={views.map((value) => ({ value, label: t(`mediaOps.state.${value}`) }))}
          onChange={(value) => setParams({ view: value })}
        />
      </div>
      {query.error && <MediaError error={query.error} />}
      {query.isPending ? (
        <SkeletonCard />
      ) : (
        <CardStatic className="divide-y divide-[var(--border)]">
          {!query.data?.tasks.length && <p className="p-6 text-sm">{t('mediaOps.empty')}</p>}
          {query.data?.tasks.map((task) => (
            <Link
              key={task.id}
              to={`/pricing/media/${encodeURIComponent(task.id)}`}
              className="block space-y-3 p-5 hover:bg-[var(--accent-muted)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="break-all text-sm font-semibold">
                  {task.model}{' '}
                  <span className="font-normal text-[var(--foreground-muted)]">/ {task.node_id}</span>
                </h2>
              </div>
              <p className="break-all font-mono text-xs">{task.id}</p>
              <MediaTaskStatus task={task} />
              <p className="text-xs text-[var(--foreground-muted)]">
                {new Date(task.created_at).toLocaleString(i18n.resolvedLanguage)}
              </p>
            </Link>
          ))}
        </CardStatic>
      )}
      <MediaPager {...pagination} busy={query.isFetching} hasMore={Boolean(query.data?.next_cursor)} />
    </div>
  )
}

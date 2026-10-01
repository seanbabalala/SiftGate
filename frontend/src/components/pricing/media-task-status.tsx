import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { mediaTaskStatus } from '@/lib/media-task-status'
import type { MediaTaskSummary } from '@/types/pricing'

export function MediaTaskStatus({ task }: { task: MediaTaskSummary }) {
  const { t } = useTranslation('pricing')
  const status = mediaTaskStatus(task)
  return (
    <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
      <div className="min-w-0">
        <dt className="text-xs text-[var(--foreground-muted)]">{t('mediaOps.providerState')}</dt>
        <dd className="mt-1">
          <Badge variant={status.generationVariant} className="whitespace-normal break-words text-left">
            {t(status.generationKey)}
          </Badge>
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-[var(--foreground-muted)]">{t('mediaOps.accountingState')}</dt>
        <dd className="mt-1">
          <Badge variant={status.accountingVariant} className="whitespace-normal break-words text-left">
            {t(status.accountingKey)}
          </Badge>
        </dd>
      </div>
    </dl>
  )
}

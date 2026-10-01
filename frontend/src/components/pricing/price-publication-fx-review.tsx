import { useTranslation } from 'react-i18next'
import type { PublicationFxReview } from '@/types/pricing'

export function PricePublicationFxReview({ review, acknowledged, onAcknowledge, disabled }: {
  review: PublicationFxReview
  acknowledged: boolean
  onAcknowledge: (accepted: boolean) => void
  disabled: boolean
}) {
  const { t } = useTranslation('pricing')
  const interval = (from: string, to: string | null) => <span className="break-all"><time dateTime={from}>{from}</time> → {to ? <time dateTime={to}>{to}</time> : t('publish.noExpiry')}</span>
  return <section className="space-y-3 border-t border-[var(--border)] pt-4" aria-label={t('publicationFx.title')}>
    <h3 className="font-semibold">{t('publicationFx.title')} · <span className="font-mono text-sm">{review.from_currency} → {review.report_currency}</span></h3>
    <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('publicationFx.help')}</p>
    {review.workspace_id === null && <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('publicationFx.globalHelp')}</p>}
    <p className={`text-sm font-medium ${review.status === 'incomplete' ? 'text-amber-700 dark:text-amber-300' : ''}`}>{t(`publicationFx.${review.status}`)}</p>
    <p className="text-xs leading-6">{t('publicationFx.window')}: {interval(review.window.effective_from, review.window.effective_to)}</p>
    {review.gaps.length > 0 && <details open><summary className="cursor-pointer text-xs font-medium">{t('publicationFx.gaps', { count: review.gaps.length })}</summary><ul className="mt-2 space-y-2 text-xs leading-5">{review.gaps.map(gap => <li key={gap.effective_from}>{interval(gap.effective_from, gap.effective_to)}</li>)}</ul></details>}
    {review.status === 'incomplete' && <label className="flex items-start gap-2 text-sm leading-6"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={disabled} onChange={event => onAcknowledge(event.target.checked)} />{t('publicationFx.acknowledge')}</label>}
  </section>
}

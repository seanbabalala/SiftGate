import { useTranslation } from 'react-i18next'
import type { PublicationTimeBasisReview } from '@/types/pricing'
import { PriceInput } from './pricing-fields'

export function PriceTimeBasisReview({ review, reference, confirmed, onReference, onConfirmed, disabled }: {
  review: PublicationTimeBasisReview
  reference: string
  confirmed: boolean
  onReference: (value: string) => void
  onConfirmed: (value: boolean) => void
  disabled: boolean
}) {
  const { t } = useTranslation('pricing')
  return <section className="space-y-3 border-t border-[var(--border)] pt-4" aria-label={t('timeReview.title')}>
    <h3 className="font-semibold">{t('timeReview.title')}</h3>
    <p className="text-sm font-medium">{t(`calendar.${review.basis}`)}</p>
    <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t(review.requires_confirmation ? 'timeReview.help' : 'timeReview.default')}</p>
    {review.requires_confirmation && <>
      {!review.uses_time_rules && <p className="text-xs leading-6 text-amber-700 dark:text-amber-300">{t('timeReview.unused')}</p>}
      <PriceInput label={t('timeReview.reference')} hint={t('timeReview.referenceHelp')} value={reference} maxLength={128} disabled={disabled} onChange={event => onReference(event.target.value)} />
      <label className="flex items-start gap-2 text-sm leading-6"><input className="mt-1" type="checkbox" disabled={disabled} checked={confirmed} onChange={event => onConfirmed(event.target.checked)} />{t('timeReview.confirm')}</label>
    </>}
  </section>
}

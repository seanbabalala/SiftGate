import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import type { PricingMeteringReview } from '../../../../src/pricing/pricing-metering.types'

const MediaSpecificationReview = lazy(() => import('./media-specification').then(module => ({ default: module.MediaSpecificationReview })))

export function PriceMeteringReview({ review }: { review: PricingMeteringReview }) {
  const { t } = useTranslation('pricing')
  const notices = [...new Set(review.targets.flatMap(row => row.notices))]
  return <section className="space-y-3 border-t border-[var(--border)] pt-4" aria-label={t('metering.title')}>
    <h3 className="font-semibold">{t('metering.title')}</h3>
    <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('metering.help')}</p>
    <p className={`text-sm font-semibold ${review.can_publish ? 'text-amber-700 dark:text-amber-300' : 'text-[var(--destructive)]'}`}>{t(review.can_publish ? 'metering.conditional' : 'metering.blocked')}</p>
    <ul className="list-disc space-y-1 pl-5 text-xs leading-6">{notices.map(code => <li key={code}>{t(`metering.notice.${code}`)}</li>)}</ul>
    {review.targets.map((row, index) => <details key={index} open={index === 0} className="border-t border-[var(--border)] pt-3">
      <summary className="cursor-pointer text-sm"><span className="break-all"><code>{row.target.model}</code> · {row.target.node_id ?? t('metering.allNodes')}</span><code className="mt-1 block break-all text-xs">{row.target.operation ?? t('metering.unspecified')}</code></summary>
      <div className="space-y-2 pt-3"><p className="break-all text-xs">{t('metering.operations')}: {row.candidate_operations.join(', ') || '—'}</p>{row.video_profile && <p className="text-xs">{t('nativeVideo.profile')}: <code>{row.video_profile}</code></p>}
        {row.media_specification && (row.media_specification.enabled || row.media_specification.adapters.length > 0) && <Suspense fallback={<p role="status">{t('working')}</p>}><MediaSpecificationReview specification={row.media_specification} /></Suspense>}
        <div className="overflow-x-auto"><table className="w-full min-w-72 text-left text-xs"><thead><tr><th className="pb-2 pr-4">{t('metering.dimension')}</th><th className="pb-2">{t('metering.availability')}</th></tr></thead><tbody>{row.dimensions.map(value => <tr key={value.dimension} className="border-t border-[var(--border)]"><td className="py-2 pr-4">{t(`dimension.${value.dimension}`)}</td><td>{t(`metering.availability.${value.availability}`)}</td></tr>)}</tbody></table></div>
      </div>
    </details>)}
  </section>
}

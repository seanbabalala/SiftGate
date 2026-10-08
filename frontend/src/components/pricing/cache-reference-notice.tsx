import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { formatCacheMoney } from '@/lib/cache-reference-display'
import type { CacheSavingsResponse } from '@/types/api'

export function CacheReferenceNotice({ data }: { data?: CacheSavingsResponse }) {
  const { t, i18n } = useTranslation('pricing')
  const summary = data?.summary?.comparison_basis === 'recorded_log_estimates' ? data.summary : undefined
  const number = (value: number) => value.toLocaleString(i18n.resolvedLanguage ?? i18n.language)
  return (
    <aside aria-label={t('cacheReference.title')} className="mt-3 min-w-0 space-y-2 border-l-2 border-[var(--border)] pl-3 text-xs leading-5 text-[var(--foreground-muted)]">
      <p>{t('cacheReference.basis')}</p>
      {summary && <p>{t('cacheReference.coverage', { comparable: number(summary.comparable_requests), eligible: number(summary.cache_eligible_requests), excluded: number(summary.excluded_requests) })}</p>}
      {(!summary || summary.comparison_status === 'unavailable') && <p>{t('cacheReference.unavailable')}</p>}
      {summary?.comparison_status === 'partial' && <p>{t('cacheReference.partial', { value: formatCacheMoney(summary.exact?.comparable_savings_usd, i18n.resolvedLanguage ?? i18n.language) })}</p>}
      {data?.scan?.has_more && <p>{t('cacheReference.truncated', { count: number(data.scan.scanned_rows), limit: number(data.scan.row_limit) })}</p>}
      <Link to="/pricing/cost-report" className="inline-block underline underline-offset-2">{t('cacheReference.details')}</Link>
    </aside>
  )
}

export function CacheBreakdownUnavailable() {
  const { t } = useTranslation('pricing')
  return <p className="py-6 text-sm leading-6 text-[var(--foreground-muted)]">{t('cacheReference.breakdownUnavailable')}</p>
}

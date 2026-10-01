import type { CacheSavingsMetrics } from '@/types/api'

export function cacheComparisonAmount(metrics: CacheSavingsMetrics | undefined, field: 'actual' | 'reference' | 'savings'): string | null {
  if (!metrics || !['complete', 'empty'].includes(metrics.comparison_status)) return null
  const key = field === 'actual' ? 'comparable_actual_usd' : field === 'reference' ? 'comparable_no_cache_usd' : 'comparable_savings_usd'
  const value = metrics.exact?.[key]
  return typeof value === 'string' && /^-?\d{1,48}\.\d{18}$/.test(value) ? value : null
}

export function formatCacheMoney(value: number | string | null | undefined, locale: string): string {
  const number = typeof value === 'string' ? Number(value) : value
  return number == null || !Number.isFinite(number)
    ? '—'
    : new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 6,
      notation: number !== 0 && Math.abs(number) < 0.000001 ? 'scientific' : 'standard' }).format(number)
}

export function formatCachePercent(value: number | null | undefined, locale: string): string {
  return value == null || !Number.isFinite(value)
    ? '—'
    : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(value / 100)
}

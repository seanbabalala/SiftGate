import { useTranslation } from 'react-i18next'
import { CostValue } from './cost-metadata'
import type { CostReportRow } from '@/types/pricing'
export function ReportCostCell({ row, failed = false }: { row?: CostReportRow; failed?: boolean }) {
  const { t } = useTranslation('pricing')
  if (!row) return <span className="text-xs text-[var(--foreground-muted)]">{t(failed ? 'report.unavailable' : 'report.loading')}</span>
  const tone = ['priced', 'free'].includes(row.status)
    ? 'bg-emerald-500/8 text-emerald-700 dark:text-emerald-400'
    : ['estimated', 'legacy_estimate'].includes(row.status)
      ? 'bg-[var(--background-secondary)] text-[var(--foreground-muted)]'
      : 'bg-amber-500/8 text-amber-700 dark:text-amber-300'
  const help = row.status === 'legacy_estimate' ? t('report.legacyHelp') : row.status === 'unpriced' ? t('report.unpricedHelp') : undefined
  return <div className="min-w-28 space-y-1.5 text-right">
    <div className="whitespace-nowrap text-xs font-medium text-[var(--foreground)]"><CostValue value={row.basis === 'legacy_log' ? row.legacy_estimate_usd : row.amount_usd} currency="USD" /></div>
    <p><span title={help} className={`inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-sans text-[10px] leading-none ${tone}`}><span aria-hidden className="h-1 w-1 rounded-full bg-current" />{t(`status.${row.status}`)}</span></p>
    {row.amount_usd === null && row.known_subtotal_usd !== null && <p className="space-y-1 text-[10px]"><span className="block font-sans text-[var(--foreground-muted)]">{t('simulation.knownSubtotal')}:</span><span className="block whitespace-nowrap"><CostValue value={row.known_subtotal_usd} currency="USD" /></span></p>}
    {row.pending_financial && <p className="text-[10px]">{t('report.pendingFinancial')}</p>}
    {row.basis === 'invalid_evidence' && <p className="text-[10px]">{t('report.invalidEvidence')}</p>}
  </div>
}

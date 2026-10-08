import { useTranslation } from 'react-i18next'
import { CostValue } from './cost-metadata'
import type { CostReportRow } from '@/types/pricing'
export function ReportCostCell({ row, failed = false }: { row?: CostReportRow; failed?: boolean }) {
  const { t } = useTranslation('pricing')
  if (!row) return <span className="text-xs text-[var(--foreground-muted)]">{t(failed ? 'report.unavailable' : 'report.loading')}</span>
  return <div className="min-w-32 space-y-1 text-right">
    <CostValue value={row.basis === 'legacy_log' ? row.legacy_estimate_usd : row.amount_usd} currency="USD" />
    <p className={`text-[10px] ${['priced', 'free'].includes(row.status) ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-300'}`}>{t(`status.${row.status}`)}</p>
    {row.amount_usd === null && row.known_subtotal_usd !== null && <p className="text-[10px]">{t('simulation.knownSubtotal')}: <CostValue value={row.known_subtotal_usd} currency="USD" /></p>}
    {row.pending_financial && <p className="text-[10px]">{t('report.pendingFinancial')}</p>}
    {row.basis === 'invalid_evidence' && <p className="text-[10px]">{t('report.invalidEvidence')}</p>}
  </div>
}

import { useTranslation } from 'react-i18next'
import { CostFacts, CostValue } from './cost-metadata'
import { verifiedCacheReference } from '@/lib/local-cache-reference'
import type { PricingLogCost, CostLedgerSummary } from '@/types/pricing'

export function LocalCacheAccounting({ ledger, log }: { ledger: CostLedgerSummary; log: PricingLogCost['log'] }) {
  const { t } = useTranslation('pricing'), reference = verifiedCacheReference(ledger)
  const bases = [...new Set(ledger.reservations.map(row => row.budget_basis === 'actual_upstream' ? 'actual_upstream' : 'legacy_logical'))]
  return <section aria-label={t('cost.localCache')} className="space-y-3 border-t border-[var(--border)] pt-4">
    <h2 className="text-sm font-semibold">{t('cost.localCache')}</h2>
    <p className="text-xs leading-5">{t('cost.cacheReferenceHelp')}</p>
    <CostFacts items={[
      [t('cost.upstream'), <CostValue value={ledger.amount} currency="USD" />],
      [t('budgetBasis.title'), bases.map(basis => t(`budgetBasis.${basis}`)).join(' · ')],
      [t('cost.logicalInput'), reference?.logical_input_tokens == null ? log.input_tokens : <CostValue value={reference.logical_input_tokens} />],
      [t('cost.logicalOutput'), reference?.logical_output_tokens == null ? log.output_tokens : <CostValue value={reference.logical_output_tokens} />],
      [t('cost.cacheFrozenReference'), <CostValue value={reference?.reference_cost_usd} currency="USD" />],
      [t('cost.cacheHypotheticalSavings'), <CostValue value={reference?.hypothetical_savings_usd} currency="USD" />],
    ]} />
    {reference?.state !== 'estimated' && <p className="text-xs text-[var(--warning)]">{t('cost.cacheReferenceUnavailable')}</p>}
    {reference?.version_id && <p className="break-all text-xs text-[var(--foreground-muted)]">{t('published')} · <code>{reference.version_id}</code></p>}
    {log.stored_reference_cost_usd !== null && <CostFacts items={[[t('cost.storedReference'), <CostValue value={log.stored_reference_cost_usd} currency="USD" />]]} />}
  </section>
}

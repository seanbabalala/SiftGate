import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { calculationPolicyFromVerifiedVersion } from '@/lib/historical-calculation-policy'
import type { ParentPrice } from '@/lib/price-inheritance-evidence'
import type { CostComputation } from '@/types/pricing'
import { CostFacts, CostValue } from './cost-metadata'

export function HistoricalCalculationPolicy({ version, cost }: { version: ParentPrice; cost: CostComputation }) {
  const { t } = useTranslation('pricing')
  const policy = useMemo(() => calculationPolicyFromVerifiedVersion(version, cost), [version, cost])
  return <section aria-label={t('calculationPolicy.title')} className="min-w-0 space-y-4 border-t border-[var(--border)] pt-4">
    <h4 className="text-sm font-semibold">{t('calculationPolicy.title')}</h4>
    <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('calculationPolicy.help')}</p>
    {!policy ? <p role="status" className="text-sm text-[var(--warning)]">{t('calculationPolicy.unavailable')}</p> : <>
      {policy.basis === 'physical_batch' && <p className="text-xs leading-6 text-[var(--warning)]">{t('calculationPolicy.physical')}</p>}
      <CostFacts items={[[t('currency'), policy.money.currency], [t('precision'), policy.money.precision], [t('moneyRounding'), t(`round.${policy.money.rounding}`)]]} />
      <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('calculationPolicy.zero')}</p>
      {!policy.lines.length && <p className="text-sm">{t('calculationPolicy.noLines')}</p>}
      {policy.lines.map(line => <section key={line.component_id} aria-label={`${t(`dimension.${line.dimension}`)} · ${line.component_id}`} className="min-w-0 space-y-3 border-t border-[var(--border)] pt-3">
        <h5 className="break-words text-sm font-medium">{t(`dimension.${line.dimension}`)} <code className="break-all text-xs text-[var(--foreground-muted)]">{line.rule_id} / {line.component_id}</code></h5>
        <CostFacts items={[
          [t('cost.quantity'), <><CostValue value={line.quantity} /> {t(`unit.${line.unit}`)}</>],
          [t('calculationPolicy.billed'), <><CostValue value={line.billed_quantity} /> {t(`unit.${line.unit}`)}</>],
          [t('rates.minimum'), line.minimum_quantity === null ? t('calculationPolicy.noMinimum') : <><CostValue value={line.minimum_quantity} /> {t(`unit.${line.unit}`)}</>],
          [t('rates.roundMode'), t(`round.${line.quantity_rounding?.mode ?? 'none'}`)],
          ...(line.quantity_rounding ? [[t('rates.increment'), <><CostValue value={line.quantity_rounding.increment} /> {t(`unit.${line.unit}`)}</>] as [string, ReactNode]] : []),
        ]} />
      </section>)}
    </>}
  </section>
}

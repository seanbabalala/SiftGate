import { useTranslation } from 'react-i18next'
import { CardStatic } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { CostFacts, CostValue } from './cost-metadata'
import type { CorrectionPreview, CorrectionCostSummary } from '@/lib/attempt-correction-form'

export function CorrectionCost({ cost, title }: { cost: CorrectionCostSummary; title: string }) {
  const { t } = useTranslation('pricing')
  return <section className="min-w-0 space-y-3" aria-label={title}><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">{title}</h3><Badge variant={cost.amount === null ? 'amber' : 'zinc'}>{t(`status.${cost.status}`)}</Badge></div><p className="text-xl"><CostValue value={cost.amount} currency={cost.currency} /></p>{cost.amount === null && <p className="text-xs">{t('simulation.knownSubtotal')}: <CostValue value={cost.subtotal} currency={cost.currency} /></p>}<CostFacts items={[[t('simulation.originalCurrency'), <CostValue value={cost.originalAmount} currency={cost.originalCurrency ?? undefined} />], [t('version'), <code>{cost.version ?? '—'}</code>], [t('simulation.fxVersion'), <code>{cost.fxVersion ?? '—'}</code>], [t('attemptCorrection.receiptHash'), <code>{cost.hash}</code>]]} /><details><summary className="cursor-pointer text-xs font-semibold">{t('simulation.formula')}</summary><ul className="mt-3 space-y-3 text-xs">{cost.lines.map((line,index) => <li key={index}><p>{t(`dimension.${line.dimension}`)}</p><p><CostValue value={line.quantity} /> × <CostValue value={line.rate} currency={line.currency} /> / <CostValue value={line.unitSize} />{line.multipliers.map((factor,index) => <span key={index}> × <CostValue value={factor} /></span>)} → <CostValue value={line.amount} currency={cost.currency} /></p></li>)}</ul></details></section>
}
export function AttemptCorrectionImpact({ preview, applied }: { preview: CorrectionPreview; applied: boolean }) {
  const { t } = useTranslation('pricing'), budget = preview.budget
  return <CardStatic className="space-y-6 p-5"><h2 className="font-semibold">{t('attemptCorrection.impact')}</h2><p className="text-sm leading-6">{t('attemptCorrection.warning')}</p><div className="grid min-w-0 gap-6 xl:grid-cols-2"><CorrectionCost title={t('attemptCorrection.before')} cost={preview.before} /><CorrectionCost title={t('attemptCorrection.after')} cost={preview.after} /></div>
    <CorrectionBudget budget={budget} applied={applied} />
  </CardStatic>
}

export function CorrectionBudget({ budget, applied }: { budget: CorrectionPreview["budget"]; applied: boolean }) {
 const { t } = useTranslation("pricing")
 return <section className="space-y-4 border-t border-[var(--border)] pt-5" aria-label={t('attemptCorrection.budget')}><div className="flex flex-wrap justify-between gap-3"><h3 className="font-semibold">{t('attemptCorrection.budget')}</h3><Badge variant="amber">{t(applied ? `cost.effect.${budget.budget_state}` : `attemptCorrection.planned.${budget.budget_state}`)}</Badge></div><p className="text-sm leading-6">{t('attemptCorrection.epochHelp')}</p>{budget.budget_state === 'not_applicable' && <p className="text-sm leading-6">{t('attemptCorrection.noEffect')}</p>}{budget.budget_state === 'pending' && <p className="text-sm leading-6 text-[var(--warning)]">{t('attemptCorrection.pending')}</p>}<CostFacts items={[[t('attemptCorrection.costBefore'), <CostValue value={budget.budget_cost_before} currency="USD" />], [t('attemptCorrection.costAfter'), <CostValue value={budget.budget_cost_after} currency="USD" />], [t('cost.costDelta'), <CostValue value={budget.cost_delta} currency="USD" />], [t('cost.tokenDelta'), <CostValue value={budget.tokens_delta} />], [t('attemptCorrection.tokensBefore'), <CostValue value={budget.budget_tokens_before} />], [t('attemptCorrection.tokensAfter'), <CostValue value={budget.budget_tokens_after} />]]} />
      <details><summary className="cursor-pointer text-sm font-semibold">{t('attemptCorrection.allocations', { count: budget.allocations.length })}</summary><p className="my-3 text-xs leading-6">{t('attemptCorrection.allocationsHelp')}</p><ul className="max-h-80 space-y-3 overflow-y-auto">{budget.allocations.map((row,index) => <li className="min-w-0 border-l border-[var(--border)] pl-3 text-xs" key={`${row.ruleId}/${index}`}><p>{t('attemptCorrection.rule', { id: row.ruleId })} · <code>{row.type}</code></p><p className="my-1 break-all font-mono">{row.periodStart}</p><CostValue value={row.amount} currency={row.type.includes('cost') ? 'USD' : undefined} /></li>)}</ul></details>
    </section>
}

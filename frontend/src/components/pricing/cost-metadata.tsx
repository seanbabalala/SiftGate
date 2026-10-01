import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { exactDisplay } from '@/lib/pricing-evidence-form'
import type { CostComputation, NormalizedUsage } from '@/types/pricing'

export function CostValue({ value, currency }: { value: string | null | undefined; currency?: string }) {
  const { i18n } = useTranslation('pricing')
  return <span className="break-all font-mono tabular-nums">{exactDisplay(value, i18n.resolvedLanguage ?? i18n.language)}{currency ? ` ${currency}` : ''}</span>
}
export function CostFacts({ items }: { items: Array<[string, ReactNode]> }) {
  const { i18n } = useTranslation('pricing')
  return <dl className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2">{items.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-[var(--foreground-muted)]">{label}</dt><dd className="mt-1 break-all text-sm">{typeof value === 'number' ? value.toLocaleString(i18n.resolvedLanguage ?? i18n.language) : value ?? '—'}</dd></div>)}</dl>
}
export function UsageEvidenceTable({ usage }: { usage: NormalizedUsage }) {
  const { t } = useTranslation('pricing')
  return <details className="min-w-0 space-y-3"><summary className="cursor-pointer text-sm font-semibold">{t('cost.usage')}</summary><p className="text-xs text-[var(--foreground-muted)]">{usage.adapter_id} · {usage.adapter_version}</p><div className="overflow-x-auto"><table className="w-full min-w-[550px] text-left text-xs"><thead className="border-b border-[var(--border)] text-[var(--foreground-muted)]"><tr><th className="py-2">{t('rates.dimension')}</th><th>{t('cost.quantity')}</th><th>{t('cost.source')}</th><th>{t('cost.quality')}</th></tr></thead><tbody>{Object.values(usage.quantities).filter((item) => item !== undefined).map((item) => <tr key={item!.dimension} className="border-b border-[var(--border)]"><td className="py-3 pr-3">{t(`dimension.${item!.dimension}`)}{item!.subset_of && <p className="mt-1 text-[10px] text-[var(--foreground-muted)]">{t('cost.subset', { dimension: t(`dimension.${item!.subset_of}`) })}</p>}</td><td className="pr-3"><CostValue value={item!.value} /> {t(`unit.${item!.unit}`)}</td><td className="pr-3">{t(`cost.source.${item!.source}`)}</td><td>{t(`cost.quality.${item!.quality}`)}</td></tr>)}</tbody></table></div></details>
}
export function CostRounding({ cost }: { cost: CostComputation }) {
  const { t } = useTranslation('pricing')
  return <CostFacts items={[[t('cost.roundingOriginal'), <CostValue value={cost.rounding_adjustment} currency={cost.currency ?? undefined} />], [t('cost.roundingReport'), <CostValue value={cost.report_rounding_adjustment} currency={cost.report_currency} />], [t('cost.calculator'), <code>{cost.calculator_version}</code>]]} />
}

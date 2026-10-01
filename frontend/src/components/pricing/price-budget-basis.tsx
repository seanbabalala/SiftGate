import { useTranslation } from 'react-i18next'
import { PriceSelect } from './pricing-fields'
import { ACTUAL_UPSTREAM_BUDGET_OPERATIONS } from '@/types/pricing'
import { actualBudgetOperation, nonTokenBudgetOperation, type TokenBudgetChoice, type BudgetBasisChoice, type admissionPolicyEffects } from '@/lib/admission-policy-form'

export function PriceBudgetBasisSelect({ value, operation, onChange }: { value: BudgetBasisChoice; operation?: string; onChange: (value: BudgetBasisChoice) => void }) {
  const { t } = useTranslation('pricing'), supported = actualBudgetOperation(operation)
  const choices: BudgetBasisChoice[] = ['', 'legacy_logical', ...(supported || value === 'actual_upstream' ? ['actual_upstream' as const] : [])]
  return <div className="space-y-2">
    <PriceSelect label={t('budgetBasis.title')} value={value} options={choices.map(value => ({ value, label: t(`budgetBasis.${value || 'default'}`) }))} onChange={value => onChange(value as BudgetBasisChoice)} />
    <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t(`budgetBasis.help.${value || 'default'}`)}</p>
    {(!supported || value === 'actual_upstream') && <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('budgetBasis.availability', { operations: ACTUAL_UPSTREAM_BUDGET_OPERATIONS.join(', ') })}</p>}
    {value === 'actual_upstream' && operation === 'realtime' && <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('budgetBasis.realtimeCustody')}</p>}
    {value === 'actual_upstream' && !supported && <p role="alert" className="text-xs text-[var(--destructive)]">{t('budgetBasis.unsupported')}</p>}
  </div>
}

export function PriceBudgetBasisImpact({ effects, global }: { effects: ReturnType<typeof admissionPolicyEffects>; global: boolean }) {
  const { t } = useTranslation('pricing')
  return <section className="space-y-3 border-t border-[var(--border)] pt-3 text-xs" aria-label={t('budgetBasis.impact')}>
    <h3 className="font-semibold">{t('budgetBasis.impact')}</h3>
    <p className="leading-5 text-[var(--foreground-muted)]">{t(global ? 'budgetBasis.globalImpact' : 'budgetBasis.workspaceImpact')}</p>
    <ul className="space-y-3">{effects.map(entry => <li key={entry.operation} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"><code className="break-all">{entry.operation}</code><span>{t(`budgetBasis.${entry.before.budget_basis ?? 'legacy_logical'}`)} → {t(`budgetBasis.${entry.after.budget_basis ?? 'legacy_logical'}`)}<br />{t('tokenBudget.title')}: {t(`tokenBudget.${entry.before.token_budget ?? 'default'}`)} → {t(`tokenBudget.${entry.after.token_budget ?? 'default'}`)}</span></li>)}</ul>
    <p className="leading-5">{t('budgetBasis.futureOnly')}</p>
  </section>
}

export function PriceTokenBudgetSelect({ value, budgetBasis, operation, onChange }: { value: TokenBudgetChoice; budgetBasis: BudgetBasisChoice; operation?: string; onChange: (value: TokenBudgetChoice) => void }) {
  const { t } = useTranslation('pricing')
  const actual = budgetBasis === 'actual_upstream', supported = actual && nonTokenBudgetOperation(operation)
  const choices: TokenBudgetChoice[] = ['', ...(actual || value === 'reported_tokens' ? ['reported_tokens' as const] : []), ...(supported || value === 'not_applicable' ? ['not_applicable' as const] : [])]
  return <div className="space-y-2 border-l-2 border-[var(--border)] pl-4">
    <PriceSelect label={t('tokenBudget.title')} value={value} options={choices.map(value => ({ value, label: t(`tokenBudget.${value || 'default'}`) }))} onChange={value => onChange(value as TokenBudgetChoice)} />
    <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t(`tokenBudget.help.${value || 'default'}`)}</p>
    {value && (!actual || value === 'not_applicable' && !supported) ? <p role="alert" className="text-xs text-[var(--destructive)]">{t('tokenBudget.unsupported')}</p> : null}
  </div>
}

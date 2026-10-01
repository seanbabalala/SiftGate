import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CardStatic } from '@/components/ui/card'
import { PriceSelect } from './pricing-fields'
import { pricingClient } from '@/lib/pricing-client'
import { pricingErrorKey } from './price-simulator'
import { PriceAdmissionDialog, PriceFxDialog } from './price-governance-dialogs'
import { PRICING_ADMISSION_OPERATIONS, type CatalogAdmissionPolicy, type CatalogFxVersion, type PricingHead } from '@/types/pricing'

export interface PolicyListing { head: PricingHead; policies: CatalogAdmissionPolicy[] }
export interface FxListing { head: PricingHead; fx_versions: CatalogFxVersion[] }

export function PriceGovernancePanel({ workspace, canManage, isDefault }: { workspace: string; canManage: boolean; isDefault: boolean }) {
  const { t } = useTranslation('pricing'), queryClient = useQueryClient()
  const request = useMemo(() => pricingClient(workspace), [workspace])
  const [open, setOpen] = useState(false), [scope, setScope] = useState('workspace'), [operation, setOperation] = useState('')
  const [dialog, setDialog] = useState<'policy' | 'fx' | null>(null)
  const policies = useQuery({ queryKey: ['pricing', workspace, 'policies'], queryFn: ({ signal }) => request<PolicyListing>('/admission-policies', undefined, 'GET', signal), enabled: open })
  const fx = useQuery({ queryKey: ['pricing', workspace, 'bindings'], queryFn: ({ signal }) => request<FxListing>('/bindings', undefined, 'GET', signal), enabled: open })
  const scopeId = scope === 'global' ? null : workspace
  const selected = policies.data?.policies.find((item) => item.workspace_id === scopeId && (item.operation ?? '') === operation)
  const editable = canManage && (scope === 'workspace' || isDefault)
  const completed = () => { setDialog(null); void queryClient.invalidateQueries({ queryKey: ['pricing', workspace] }) }
  const failed = policies.error ?? fx.error
  return <CardStatic className="p-4 sm:p-5"><details onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-semibold"><SlidersHorizontal className="mr-2 inline h-4 w-4 text-[var(--accent)]" />{t('governance.title')}</summary>
    <p className="mt-3 max-w-4xl text-xs leading-5 text-[var(--foreground-muted)]">{t('governance.help')}</p>
    <div className="mt-4 grid gap-5 lg:grid-cols-2">
      <section className="space-y-3"><PriceSelect label={t('scope')} value={scope} options={['workspace', 'global'].map((value) => ({ value, label: t(`scope.${value}`) }))} onChange={setScope} /><h3 className="text-sm font-semibold">{t('admission.title')}</h3><PriceSelect label={t('publish.operation')} value={operation} options={[{ value: '', label: t('publish.allOperations') }, ...PRICING_ADMISSION_OPERATIONS.map((value) => ({ value, label: value }))]} onChange={setOperation} />
        <p className="text-sm">{t('admission.current')}: <strong>{t(`admission.${selected?.policy.mode ?? 'inherit'}`)}</strong></p>{selected && <p className="text-xs">{t('budgetBasis.title')}: {t(`budgetBasis.${selected.policy.budget_basis ?? 'default'}`)} · {t('tokenBudget.title')}: {t(`tokenBudget.${selected.policy.token_budget ?? 'default'}`)}</p>}<p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('admission.inheritance')}</p>
        <ul className="space-y-2 text-xs">{policies.data?.policies.map((entry) => <li key={`${entry.workspace_id}/${entry.operation}`} className="rounded bg-[var(--background)] p-2">{t(entry.workspace_id ? 'scope.workspace' : 'scope.global')} · <code>{entry.operation ?? t('publish.allOperations')}</code> · {t(`admission.${entry.policy.mode}`)} · {t(`budgetBasis.${entry.policy.budget_basis ?? 'default'}`)} · {t(`tokenBudget.${entry.policy.token_budget ?? 'default'}`)}</li>)}</ul>
        <div className="flex flex-wrap items-center gap-4"><Button size="sm" variant="outline" disabled={!editable || !policies.data || policies.isFetching} onClick={() => setDialog('policy')}>{t('admission.edit')}</Button><Link className="text-sm underline" to="/pricing/admission-preview">{t('admissionPreview.title')}</Link></div>
      </section>
      <section className="space-y-3"><h3 className="text-sm font-semibold">{t('fx.title')}</h3><p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('fx.help')}</p><ul className="space-y-3">{fx.data?.fx_versions.map((entry) => <li key={entry.fx.version_id} className="rounded border border-[var(--border)] p-3 text-xs"><p className="font-mono">1 {entry.fx.from_currency} = {entry.fx.numerator} / {entry.fx.denominator} {entry.fx.to_currency}</p><p className="mt-1">{t(entry.workspace_id ? 'scope.workspace' : 'scope.global')} · {entry.fx.effective_at}{entry.effective_to ? ` → ${entry.effective_to}` : ''}</p><p className="mt-1 break-all text-[var(--foreground-muted)]">{entry.fx.source} · {entry.fx.version_id}</p></li>)}</ul>{fx.data?.fx_versions.length === 0 && <p className="text-xs">{t('fx.empty')}</p>}
        <Button size="sm" variant="outline" disabled={!editable || !fx.data || fx.isFetching} onClick={() => setDialog('fx')}>{t('fx.edit')}</Button>
      </section>
    </div>{failed && <p role="alert" className="mt-4 text-sm text-[var(--destructive)]">{t(pricingErrorKey(failed))}</p>}
  </details>
    {dialog === 'policy' && policies.data && <PriceAdmissionDialog workspace={workspace} scope={scope as 'global' | 'workspace'} operation={operation || undefined} listing={policies.data} onClose={() => setDialog(null)} onSaved={completed} />}
    {dialog === 'fx' && fx.data && <PriceFxDialog workspace={workspace} scope={scope as 'global' | 'workspace'} listing={fx.data} onClose={() => setDialog(null)} onSaved={completed} />}
  </CardStatic>
}

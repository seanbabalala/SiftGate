import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PriceInput, PriceSelect } from './pricing-fields'
import { PriceBudgetBasisSelect, PriceBudgetBasisImpact, PriceTokenBudgetSelect } from './price-budget-basis'
import { admissionPolicyWithBasis, admissionPolicyWithTokenBudget, admissionPolicyEffects, actualBudgetOperation, nonTokenBudgetOperation, type TokenBudgetChoice, type BudgetBasisChoice } from '@/lib/admission-policy-form'
import { PricingDiagnostics, pricingErrorKey } from './price-simulator'
import { usePricingNavigationState } from './pricing-navigation-guard'
import { pricingClient, PricingApiError } from '@/lib/pricing-client'
import { changedPaths } from '@/lib/pricing-model'
import { DIMENSION_UNITS, type MeterDimension, type PricingAdmissionPolicy, type PricingDiagnostic, type PricingFxUpdate } from '@/types/pricing'
import type { FxListing, PolicyListing } from './price-governance-panel'
import { RealtimeTranscriptionFields } from './realtime-transcription-fields'
import { transcriptionDeclaration, validTranscriptionDeclaration } from '@/lib/admission-policy-form'

interface DialogProps { workspace: string; scope: 'global' | 'workspace'; onClose: () => void; onSaved: () => void }
function useGovernanceChange(workspace: string, path: string, payload: unknown, dirty: boolean, onSaved: () => void) {
  const { t } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false)
  const [diagnostics, setDiagnostics] = useState<PricingDiagnostic[]>([]), [previewed, setPreviewed] = useState(''), [confirmed, setConfirmed] = useState(false)
  const signature = JSON.stringify(payload)
  const releaseGuard = usePricingNavigationState(dirty, busy)
  const act = async (publish: boolean) => {
    if (busy || stale || (publish && (!confirmed || previewed !== signature))) return
    setBusy(true); setError(''); setDiagnostics([])
    try {
      await request(`${path}${publish ? '' : '/preview'}`, payload, publish ? 'PUT' : 'POST')
      if (publish) { releaseGuard(); onSaved() }
      else { setPreviewed(signature); setConfirmed(false) }
    } catch (failure) {
      setError(t(pricingErrorKey(failure))); setPreviewed(''); setConfirmed(false)
      if (failure instanceof PricingApiError) { setDiagnostics(failure.diagnostics); if (failure.status === 409) setStale(true) }
    } finally { setBusy(false) }
  }
  const close = (onClose: () => void) => { if (!busy && (!dirty || window.confirm(t('discardConfirm')))) onClose() }
  return { busy, stale, error, diagnostics, validPreview: previewed === signature, confirmed, setConfirmed, act, close }
}

function ChangeActions({ change, reason, onClose, blocked = false }: { change: ReturnType<typeof useGovernanceChange>; reason: string; onClose: () => void; blocked?: boolean }) {
  const { t } = useTranslation('pricing')
  return <>
    {change.error && <p role="alert" className="text-sm text-[var(--destructive)]">{change.error}</p>}
    {change.stale && <p className="text-xs leading-5 text-[var(--foreground-muted)]">{t('governance.stale')}</p>}
    <PricingDiagnostics diagnostics={change.diagnostics} />
    {change.validPreview && <label className="flex items-start gap-2 rounded-lg border border-[var(--border-hover)] p-3 text-sm"><input type="checkbox" checked={change.confirmed} disabled={change.busy} onChange={(event) => change.setConfirmed(event.target.checked)} />{t('governance.confirm')}</label>}
    <DialogFooter><Button variant="ghost" disabled={change.busy} onClick={() => change.close(onClose)}>{t('cancel')}</Button><Button variant="outline" disabled={blocked || change.busy || change.stale || !reason.trim()} onClick={() => void change.act(false)}>{t('governance.validate')}</Button><Button disabled={blocked || change.busy || change.stale || !change.validPreview || !change.confirmed} onClick={() => void change.act(true)}>{t(change.busy ? 'working' : 'governance.apply')}</Button></DialogFooter>
  </>
}

export function PriceAdmissionDialog({ workspace, scope, operation, listing, onClose, onSaved }: DialogProps & { operation?: string; listing: PolicyListing }) {
  const { t } = useTranslation('pricing')
  const [original] = useState(() => structuredClone(listing.policies.find((item) => item.workspace_id === (scope === 'global' ? null : workspace) && item.operation === operation)?.policy ?? null))
  const [mode, setMode] = useState<PricingAdmissionPolicy['mode'] | 'inherit'>(original?.mode ?? 'inherit')
  const [budgetBasis, setBudgetBasis] = useState<BudgetBasisChoice>(original?.budget_basis ?? '')
  const [tokenBudget, setTokenBudget] = useState<TokenBudgetChoice>(original?.token_budget ?? '')
  const [originalPolicies] = useState(() => structuredClone(listing.policies))
  const [limits, setLimits] = useState<Partial<Record<MeterDimension, string>>>(() => ({ ...original?.quantity_limits }))
  const [reference, setReference] = useState(original?.limit_reference ?? ''), [reason, setReason] = useState('')
  const [maxResponses, setMaxResponses] = useState(original?.realtime_max_responses === undefined ? '' : String(original.realtime_max_responses))
  const [asrModel, setAsrModel] = useState(original?.realtime_transcription?.model ?? '')
  const [asrLimit, setAsrLimit] = useState(original?.realtime_transcription ? String(original.realtime_transcription.max_items) : '')
  const [revision] = useState(listing.head.revision)
  const quantityLimits = Object.fromEntries(Object.entries(limits).filter(([, value]) => value?.trim()).map(([key, value]) => [key, value!.trim()]))
  const asr = transcriptionDeclaration(asrModel, asrLimit)
  const policy = admissionPolicyWithTokenBudget(admissionPolicyWithBasis(mode === 'inherit' ? null : { mode, ...(asr ? { realtime_transcription: asr } : {}), ...(maxResponses.trim() ? { realtime_max_responses: /^\d+$/.test(maxResponses.trim()) ? Number(maxResponses) : 0 } : {}), ...(Object.keys(quantityLimits).length ? { quantity_limits: quantityLimits, limit_reference: reference.trim() } : {}) }, budgetBasis), tokenBudget)
  const effects = admissionPolicyEffects(originalPolicies, scope === 'global' ? null : workspace, operation, policy)
  const unsupported = policy?.budget_basis === 'actual_upstream' && !actualBudgetOperation(operation) || Boolean(policy?.token_budget && (policy.budget_basis !== 'actual_upstream' || policy.token_budget === 'not_applicable' && !nonTokenBudgetOperation(operation))) || Boolean(policy?.realtime_transcription && (operation !== 'realtime' || !validTranscriptionDeclaration(asrModel, asrLimit)))
  const dirty = changedPaths(original, policy).length > 0 || Boolean(reason) || reference !== (original?.limit_reference ?? '')
  const change = useGovernanceChange(workspace, '/admission-policy', { catalog_revision: revision, reason: reason.trim(), confirm: true, scope, operation, policy }, dirty, onSaved)
  return <Dialog open onOpenChange={(open) => { if (!open) change.close(onClose) }}><DialogContent className="max-w-3xl" ariaLabel={t('admission.edit')}><DialogHeader><DialogTitle>{t('admission.edit')}</DialogTitle></DialogHeader>
    <p className="text-xs text-[var(--foreground-muted)]">{t(`scope.${scope}`)} · {operation ?? t('publish.allOperations')} · {t('catalogRevision', { revision })}</p>
    <fieldset disabled={change.busy || change.stale} className="space-y-4"><PriceSelect label={t('admission.mode')} value={mode} options={['inherit', 'compatibility', 'reject_unpriced', 'reserve_upper_bound'].map((value) => ({ value, label: t(`admission.${value}`) }))} onChange={(value) => setMode(value as typeof mode)} />
      <p className="text-sm leading-6 text-[var(--foreground-muted)]">{t(`admission.help.${mode}`)}</p>
      {mode !== 'inherit' && <><PriceBudgetBasisSelect value={budgetBasis} operation={operation} onChange={setBudgetBasis} /><PriceTokenBudgetSelect value={tokenBudget} budgetBasis={budgetBasis} operation={operation} onChange={setTokenBudget} /></>}
      {mode !== 'inherit' && <details open={mode === 'reserve_upper_bound' || undefined}><summary className="cursor-pointer text-sm font-semibold">{t('admission.limits')}</summary><p className="my-3 text-xs leading-5 text-[var(--foreground-muted)]">{t('admission.limitHelp')}</p><PriceInput label={t('admission.reference')} maxLength={256} value={reference} onChange={(event) => setReference(event.target.value)} /><div className="mt-4 grid gap-3 sm:grid-cols-2">{(Object.keys(DIMENSION_UNITS) as MeterDimension[]).map((dimension) => <PriceInput key={dimension} label={`${t(`dimension.${dimension}`)} (${t(`unit.${DIMENSION_UNITS[dimension]}`)})`} inputMode="decimal" value={limits[dimension] ?? ''} placeholder={t('admission.unbounded')} onChange={(event) => setLimits((old) => ({ ...old, [dimension]: event.target.value }))} />)}</div></details>}
      {mode !== 'inherit' && (operation === 'realtime' || original?.realtime_max_responses !== undefined) && <PriceInput label={t('admission.realtimeMaxResponses')} hint={t('admission.realtimeHelp')} inputMode="numeric" value={maxResponses} onChange={event => setMaxResponses(event.target.value)} />}
      {mode !== 'inherit' && (operation === 'realtime' || original?.realtime_transcription) && <RealtimeTranscriptionFields model={asrModel} limit={asrLimit} onModel={setAsrModel} onLimit={setAsrLimit} />}
      <PriceInput label={t('publish.reason')} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
    </fieldset>
    <section className="space-y-2 rounded bg-[var(--background)] p-3 text-xs"><h3 className="font-semibold">{t('governance.preview')}</h3><p>{t(`admission.${original?.mode ?? 'inherit'}`)} → {t(`admission.${mode}`)}</p><p>{t('admission.limitCount', { count: mode === 'inherit' ? 0 : Object.keys(quantityLimits).length })}</p><p className="leading-5 text-[var(--foreground-muted)]">{t('governance.safety')}</p></section>
    <PriceBudgetBasisImpact effects={effects} global={scope === 'global'} />
    {(original?.realtime_transcription || asr) && <p className="break-all text-xs">{t('transcription.title')}: {original?.realtime_transcription?.model ?? '—'} / {original?.realtime_transcription?.max_items ?? '—'} → {policy?.realtime_transcription?.model ?? '—'} / {policy?.realtime_transcription?.max_items ?? '—'}</p>}
    <ChangeActions change={change} reason={reason} onClose={onClose} blocked={unsupported} />
  </DialogContent></Dialog>
}

export function PriceFxDialog({ workspace, scope, listing, onClose, onSaved }: DialogProps & { listing: FxListing }) {
  const { t } = useTranslation('pricing')
  const [original] = useState(() => structuredClone(listing.fx_versions.filter((entry) => entry.workspace_id === (scope === 'global' ? null : workspace)).map(({ fx, effective_to }) => ({ fx, ...(effective_to ? { effective_to } : {}) }))))
  const [versions, setVersions] = useState<PricingFxUpdate['versions']>(() => structuredClone(original)), [reason, setReason] = useState('')
  const [revision] = useState(listing.head.revision)
  const dirty = JSON.stringify(versions) !== JSON.stringify(original) || Boolean(reason)
  const change = useGovernanceChange(workspace, '/fx', { catalog_revision: revision, reason: reason.trim(), confirm: true, scope, versions }, dirty, onSaved)
  const patch = (index: number, value: Partial<PricingFxUpdate['versions'][number]['fx']>) => setVersions((old) => old.map((entry, i) => i === index ? { ...entry, fx: { ...entry.fx, ...value } } : entry))
  return <Dialog open onOpenChange={(open) => { if (!open) change.close(onClose) }}><DialogContent className="max-w-3xl" ariaLabel={t('fx.edit')}><DialogHeader><DialogTitle>{t('fx.edit')}</DialogTitle></DialogHeader>
    <p className="text-xs text-[var(--foreground-muted)]">{t(`scope.${scope}`)} · {t('catalogRevision', { revision })}</p><p className="text-sm leading-6 text-[var(--foreground-muted)]">{t('fx.replacement')}</p>
    <fieldset disabled={change.busy || change.stale} className="space-y-4">{versions.map((entry, index) => <section key={entry.fx.version_id} className="space-y-3 rounded-lg border border-[var(--border)] p-4"><div className="grid gap-3 sm:grid-cols-2"><PriceInput label={t('fx.from')} maxLength={3} value={entry.fx.from_currency} onChange={(event) => patch(index, { from_currency: event.target.value.toUpperCase() })} /><PriceInput label={t('fx.to')} maxLength={3} value={entry.fx.to_currency} onChange={(event) => patch(index, { to_currency: event.target.value.toUpperCase() })} /><PriceInput label={t('fx.numerator')} inputMode="decimal" value={entry.fx.numerator} onChange={(event) => patch(index, { numerator: event.target.value })} /><PriceInput label={t('fx.denominator')} inputMode="decimal" value={entry.fx.denominator} onChange={(event) => patch(index, { denominator: event.target.value })} /><PriceInput label={t('publish.from')} value={entry.fx.effective_at} onChange={(event) => patch(index, { effective_at: event.target.value })} /><PriceInput label={t('publish.to')} value={entry.effective_to ?? ''} placeholder={t('publish.noExpiry')} onChange={(event) => setVersions((old) => old.map((row, i) => i === index ? { ...row, effective_to: event.target.value || undefined } : row))} /></div><PriceInput label={t('fx.source')} value={entry.fx.source} onChange={(event) => patch(index, { source: event.target.value })} /><p className="break-all font-mono text-xs">1 {entry.fx.from_currency} = {entry.fx.numerator || '?'} / {entry.fx.denominator || '?'} {entry.fx.to_currency}</p><Button size="sm" variant="ghost" onClick={() => { if (window.confirm(t('removeConfirm'))) setVersions((old) => old.filter((_, i) => i !== index)) }}>{t('remove')}</Button></section>)}
      <Button variant="outline" size="sm" disabled={versions.length >= 128} onClick={() => setVersions((old) => [...old, { fx: { version_id: crypto.randomUUID(), from_currency: '', to_currency: 'USD', numerator: '', denominator: '1', effective_at: new Date().toISOString(), source: '' } }])}>{t('fx.add')}</Button>
      <PriceInput label={t('publish.reason')} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
    </fieldset>
    <section className="rounded bg-[var(--background)] p-3 text-xs"><h3 className="font-semibold">{t('governance.preview')}</h3><p className="mt-2">{t('fx.impact', { before: original.length, after: versions.length })}</p><p className="mt-2 leading-5 text-[var(--foreground-muted)]">{t('governance.safety')}</p></section>
    <ChangeActions change={change} reason={reason} onClose={onClose} />
  </DialogContent></Dialog>
}

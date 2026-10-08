import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { RealtimeTranscriptionFields } from '@/components/pricing/realtime-transcription-fields'
import { ShieldCheck } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { CardStatic } from '@/components/ui/card'
import { Button, buttonVariants } from '@/components/ui/button'
import { SkeletonCard } from '@/components/ui/skeleton'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { PriceInput, PriceSelect } from '@/components/pricing/pricing-fields'
import { PricingNavigationGuard, usePricingNavigationState } from '@/components/pricing/pricing-navigation-guard'
import { AdmissionPreviewResult } from '@/components/pricing/admission-preview-result'
import { PriceBudgetBasisSelect, PriceTokenBudgetSelect } from '@/components/pricing/price-budget-basis'
import { PricingDiagnostics, pricingErrorKey } from '@/components/pricing/price-simulator'
import { admissionScenario, admissionPreviewInput, admissionPreviewReady, verifyAdmissionPreview, previewDimensions, previewQuantity, PREVIEW_QUALITIES, PREVIEW_SOURCES, type AdmissionScenario, type AdmissionPreviewView } from '@/lib/admission-preview-form'
import { pricingClient, PricingApiError } from '@/lib/pricing-client'
import { DIMENSION_UNITS, MEDIA_ATTRIBUTES, PRICING_ADMISSION_OPERATIONS, type MeterDimension, type PricingDiagnostic } from '@/types/pricing'
import type { PricingAdmissionPreview } from '../../../src/pricing/pricing-admission-preview.types'

export function AdmissionPreviewPage() {
  const { data, error, isLoading } = useWorkspaces(), { t } = useTranslation('pricing')
  if (isLoading) return <SkeletonCard />
  if (error || !data?.access) return <p role="alert">{t('error.workspace')}</p>
  return <PricingNavigationGuard key={`${data.active_workspace.id}/${data.access.user_id}`}><AdmissionSimulator workspace={data.active_workspace.id} /></PricingNavigationGuard>
}
function AdmissionSimulator({ workspace }: { workspace: string }) {
  const { t } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const [state, setState] = useState(admissionScenario), [busy, setBusy] = useState(false), [error, setError] = useState(''), [diagnostics, setDiagnostics] = useState<PricingDiagnostic[]>([])
  const [result, setResult] = useState<{ view: AdmissionPreviewView; signature: string } | null>(null)
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  usePricingNavigationState(false, busy)
  const patch = (value: Partial<AdmissionScenario>) => { setState(old => ({ ...old, ...value })); setError('') }
  const dimensionOptions = (Object.keys(DIMENSION_UNITS) as MeterDimension[]).map(value => ({ value, label: t(`dimension.${value}`) }))
  const [extra, setExtra] = useState<MeterDimension>('request_count')
  const addQuantity = () => { if (!state.quantities.some(row => row.dimension === extra)) patch({ quantities: [...state.quantities, previewQuantity(extra)] }) }
  const example = () => patch({ quantities: previewDimensions(state.operation).map(key => ({ ...previewQuantity(key), value: DIMENSION_UNITS[key] === 'token' ? ['total_input_tokens', 'uncached_input_tokens'].includes(key) ? '1000' : key === 'output_tokens' ? '100' : '0' : '1' })) })
  const run = async () => {
    if (active.current || !admissionPreviewReady(state)) return
    const body = admissionPreviewInput(state), signature = JSON.stringify(state), controller = new AbortController()
    active.current = controller; setBusy(true); setError(''); setDiagnostics([]); setResult(null)
    try {
      const reply = await request<PricingAdmissionPreview>('/admission-preview', body, 'POST', controller.signal)
      const view = await verifyAdmissionPreview(reply, body, workspace)
      if (!controller.signal.aborted) setResult({ view, signature })
    } catch (failure) {
      if (!controller.signal.aborted) { setError(t(failure instanceof Error && failure.message === 'invalid_admission_preview' ? 'admissionPreview.invalidReply' : pricingErrorKey(failure))); if (failure instanceof PricingApiError) setDiagnostics(failure.diagnostics) }
    } finally { if (active.current === controller) { active.current = null; if (!controller.signal.aborted) setBusy(false) } }
  }
  return <div className="space-y-5"><PageHeader title={t('admissionPreview.title')} description={t('admissionPreview.help')} icon={ShieldCheck}><Link className={buttonVariants({ variant: 'outline' })} to="/pricing">{t('admissionPreview.back')}</Link></PageHeader>
    <p className="border-l-2 border-amber-500 pl-4 text-sm leading-6">{t('admissionPreview.safety')}</p>
    <CardStatic className="space-y-5 p-5"><fieldset disabled={busy} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2"><PriceInput label={t('publish.model')} value={state.model} maxLength={256} onChange={e => patch({ model: e.target.value })} /><PriceInput label={t('publish.node')} value={state.node} maxLength={128} onChange={e => patch({ node: e.target.value })} /><PriceSelect label={t('admissionPreview.operation')} value={state.operation} options={PRICING_ADMISSION_OPERATIONS.map(value => ({ value, label: value }))} onChange={operation => patch({ operation })} /><PriceInput label={t('admissionPreview.attempts')} inputMode="numeric" value={state.attempts} maxLength={4} onChange={e => patch({ attempts: e.target.value })} /></div>
      <h2 className="font-semibold">{t('admissionPreview.quantities')}</h2><p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('admissionPreview.evidenceHelp')}</p>
      <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={() => patch({ quantities: previewDimensions(state.operation).map(previewQuantity) })}>{t('admissionPreview.resetQuantities')}</Button><Button variant="outline" onClick={example}>{t('simulation.example')}</Button></div>
      <div className="divide-y divide-[var(--border)]">{state.quantities.map((row, index) => <fieldset key={row.dimension} aria-label={t(`dimension.${row.dimension}`)} className="grid items-end gap-3 py-4 sm:grid-cols-2 xl:grid-cols-[minmax(180px,2fr)_minmax(120px,1fr)_minmax(120px,1fr)_auto]">
        <PriceInput label={`${t(`dimension.${row.dimension}`)} (${t(`unit.${DIMENSION_UNITS[row.dimension]}`)})`} value={row.value} disabled={['missing', 'unsupported'].includes(row.quality)} inputMode="decimal" placeholder={t('simulation.missing')} onChange={e => patch({ quantities: state.quantities.map((q, i) => i === index ? { ...q, value: e.target.value } : q) })} />
        <PriceSelect label={t('cost.source')} value={row.source} options={PREVIEW_SOURCES.map(value => ({ value, label: t(`cost.source.${value}`) }))} onChange={value => patch({ quantities: state.quantities.map((q, i) => i === index ? { ...q, source: value as typeof q.source, quality: value === 'heuristic' && q.quality === 'observed' ? 'estimated' : q.quality } : q) })} />
        <PriceSelect label={t('cost.quality')} value={row.quality} options={PREVIEW_QUALITIES.map(value => ({ value, label: t(`cost.quality.${value}`) }))} onChange={value => patch({ quantities: state.quantities.map((q, i) => i === index ? { ...q, quality: value as typeof q.quality } : q) })} />
        <Button variant="ghost" onClick={() => patch({ quantities: state.quantities.filter((_, i) => i !== index) })} aria-label={`${t('remove')} ${t(`dimension.${row.dimension}`)}`}>{t('remove')}</Button>
      </fieldset>)}</div>
      <div className="flex flex-wrap items-end gap-3"><div className="min-w-48 flex-1"><PriceSelect label={t('admissionPreview.addDimension')} value={extra} options={dimensionOptions} onChange={value => setExtra(value as MeterDimension)} /></div><Button variant="outline" disabled={state.quantities.some(q => q.dimension === extra)} onClick={addQuantity}>{t('admissionPreview.add')}</Button></div>
      <details className="space-y-4"><summary className="cursor-pointer font-semibold">{t('admissionPreview.conditions')}</summary><div className="grid gap-4 sm:grid-cols-2"><PriceInput label={t('admissionPreview.dispatchedAt')} value={state.dispatchedAt} onChange={e => patch({ dispatchedAt: e.target.value })} /><PriceInput label={t('admissionPreview.acceptedAt')} value={state.acceptedAt} onChange={e => patch({ acceptedAt: e.target.value })} /><PriceInput label={t('admissionPreview.completedAt')} value={state.completedAt} onChange={e => patch({ completedAt: e.target.value })} /><PriceInput label={t('simulation.requestedTier')} value={state.requestedTier} onChange={e => patch({ requestedTier: e.target.value })} /><PriceInput label={t('simulation.resolvedTier')} value={state.resolvedTier} onChange={e => patch({ resolvedTier: e.target.value })} /></div><p className="text-xs leading-6">{t('admissionPreview.timeHelp')}</p><div className="grid gap-3 sm:grid-cols-2">{MEDIA_ATTRIBUTES.map(key => <PriceInput key={key} label={t(`media.${key}`)} value={state.media[key] ?? ''} maxLength={128} onChange={e => patch({ media: { ...state.media, [key]: e.target.value } })} />)}</div></details>
      <section className="space-y-4 border-t border-[var(--border)] pt-5"><label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={state.override} onChange={e => patch({ override: e.target.checked })} />{t('admissionPreview.override')}</label><p className="text-xs leading-6">{t('admissionPreview.overrideHelp')}</p>
        {state.override && <><PriceBudgetBasisSelect value={state.budgetBasis ?? ''} operation={state.operation} onChange={budgetBasis => patch({ budgetBasis })} /><PriceTokenBudgetSelect value={state.tokenBudget ?? ''} budgetBasis={state.budgetBasis ?? ''} operation={state.operation} onChange={tokenBudget => patch({ tokenBudget })} /><PriceSelect label={t('admission.mode')} value={state.mode} options={['compatibility', 'reject_unpriced', 'reserve_upper_bound'].map(value => ({ value, label: t(`admission.${value}`) }))} onChange={mode => patch({ mode: mode as AdmissionScenario['mode'] })} /><p className="text-xs leading-6">{t('admission.limitHelp')}</p><details className="space-y-4"><summary className="cursor-pointer text-sm font-semibold">{t('admission.limits')}</summary><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{dimensionOptions.map(option => <PriceInput key={option.value} label={option.label} inputMode="decimal" value={state.limits[option.value] ?? ''} placeholder={t('admission.unbounded')} onChange={e => patch({ limits: { ...state.limits, [option.value]: e.target.value } })} />)}</div></details>{state.operation === 'realtime' && <PriceInput label={t('admission.realtimeMaxResponses')} hint={t('admission.realtimeHelp')} inputMode="numeric" value={state.realtimeMaxResponses ?? ''} onChange={e => patch({ realtimeMaxResponses: e.target.value })} />}{state.operation === 'realtime' && <RealtimeTranscriptionFields model={state.transcriptionModel ?? ''} limit={state.transcriptionLimit ?? ''} onModel={transcriptionModel => patch({ transcriptionModel })} onLimit={transcriptionLimit => patch({ transcriptionLimit })} />}<PriceInput label={t('admission.reference')} value={state.reference} maxLength={256} onChange={e => patch({ reference: e.target.value })} /></>}
      </section>
    </fieldset>
      {!admissionPreviewReady(state) && <p className="text-xs text-amber-700 dark:text-amber-300">{t('admissionPreview.invalidInputs')}</p>}
      <Button disabled={busy || !admissionPreviewReady(state)} onClick={() => void run()}>{t(busy ? 'working' : 'admissionPreview.run')}</Button>
      {busy && <Button variant="outline" onClick={() => { const controller = active.current; active.current = null; controller?.abort(); setBusy(false) }}>{t('cancel')}</Button>}
      {error && <p role="alert" className="text-sm text-[var(--destructive)]">{error}</p>}<PricingDiagnostics diagnostics={diagnostics} />
    </CardStatic>
    {result && <AdmissionPreviewResult view={result.view} stale={result.signature !== JSON.stringify(state)} />}
  </div>
}
